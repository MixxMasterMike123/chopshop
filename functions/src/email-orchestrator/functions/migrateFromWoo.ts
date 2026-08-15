// migrateFromWoo — PLATFORM-only one-click demo migration from a WooCommerce shop.
// Ingests the PUBLIC WooCommerce Store API (/wp-json/wc/store/products — no
// credentials) and creates products in OUR platform for the target shop. Same
// DISPLAY/DEMO contract as migrateFromShopify: no orders/customers/inventory-truth/
// print-masters. Shares the money-path helpers (slug/sku/variant derivation +
// image reupload + SSRF guard) with the Shopify importer via migrationShared.ts.
//
// Woo footguns (handled below): the Store API returns a BARE JSON ARRAY (not
// {products:[]}) served with a UTF-8 BOM; pagination is via the X-WP-TotalPages
// response header; product names carry HTML entities; prices are minor-unit
// strings; categories are hierarchical (pick the leaf); there is one size axis
// ('Storlek') and NO colorway.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue } from 'firebase-admin/firestore';
import { appUrls } from '../../config/app-urls';
import { db } from '../../config/database';
import { requireAdminOfShop } from './authGuard';
import {
  skuFromName, uniqueSku, deriveVariantsFromGroups, isBlockedHost, makeReuploadImage, writeProgress,
  safePublicFetch,
  type RawGroup, type CleanGroup, type VariantRow,
} from './migrationShared';

// ── Woo Store API types (only the fields we read) ──
interface WooImage { src: string; }
interface WooTerm { name: string; }
interface WooAttribute { name: string; has_variations: boolean; terms: WooTerm[]; }
interface WooCategory { name: string; }
interface WooPrices { price: string; regular_price?: string; currency_minor_unit: number; currency_code?: string; }
interface WooProduct {
  id: number;
  name: string;
  slug?: string;
  type: string; // 'variable' | 'simple' | 'gift-card' | …
  sku: string;
  prices: WooPrices;
  short_description?: string;
  description?: string;
  images: WooImage[];
  categories: WooCategory[];
  attributes: WooAttribute[];
}

// Woo `name`/category names carry HTML entities (&#8221;, &amp;, &quot;, …). No
// decoder exists in the repo and we add no dep — this tiny map covers the
// storefront cases; an exotic named entity passes through unharmed (cosmetic).
const decodeEntities = (s: string): string =>
  (s || '')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last: so an entity decoded above isn't re-processed

// Category = the most-specific non-generic category name. Woo returns them flat;
// 'Nyheter'/'Accessoarer' are storefront buckets, not real categories.
const GENERIC_CATS = new Set(['nyheter', 'accessoarer']);
const wooCategory = (cats: WooCategory[]): string => {
  const names = (cats || []).map((c) => decodeEntities((c?.name || '').trim())).filter(Boolean);
  const specific = names.filter((n) => !GENERIC_CATS.has(n.toLowerCase()));
  return (specific.length ? specific[specific.length - 1] : names[names.length - 1]) || '';
};

// Woo prices are minor-unit strings: '59900' with currency_minor_unit 2 → 599.00.
const wooPrice = (p?: WooPrices): number => {
  const minor = Number(p?.price);
  const unit = Number(p?.currency_minor_unit ?? 2);
  return Number.isFinite(minor) ? minor / 10 ** unit : 0;
};

interface MigrateWooRequest { shopId: string; wooDomain: string; migrationId: string; limit?: number; }

export const migrateFromWoo = onCall<MigrateWooRequest>(
  {
    region: 'us-central1',
    memory: '1GiB',
    timeoutSeconds: 540,
    cors: appUrls.CORS_ORIGINS,
  },
  async (request) => {
    // Platform OR admin-of-this-shop (platform acts on any shop; a shop admin only
    // their own) — same guard as the Shopify importer.
    await requireAdminOfShop(request.data.shopId, request.auth?.uid);

    const shopId = (request.data.shopId || '').trim();
    if (!shopId) throw new HttpsError('invalid-argument', 'shopId saknas.');
    const migrationId = (request.data.migrationId || '').trim();
    if (!migrationId) throw new HttpsError('invalid-argument', 'migrationId saknas.');

    // Normalise the Woo domain (accept "shop.x.com", "https://shop.x.com/sv", …).
    let host: string;
    try {
      const raw = (request.data.wooDomain || '').trim();
      const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      host = new URL(withProto).host;
    } catch {
      throw new HttpsError('invalid-argument', 'Ogiltig WooCommerce-adress.');
    }
    if (!host) throw new HttpsError('invalid-argument', 'Ogiltig WooCommerce-adress.');
    if (isBlockedHost(host)) throw new HttpsError('invalid-argument', 'Otillåten adress.');

    const shopSnap = await db.collection('shops').doc(shopId).get();
    if (!shopSnap.exists) throw new HttpsError('not-found', `Butiken "${shopId}" finns inte.`);

    await writeProgress(migrationId, {
      shopId, source: 'woo', host, total: 0, done: 0, phase: 'fetching',
      createdAt: FieldValue.serverTimestamp(),
    });

    try {
      // ── 1. Fetch the public catalog (WooCommerce Store API; 100/page). ──
      const maxProducts = Math.min(Math.max(1, request.data.limit || 1000), 2000);
      const products: WooProduct[] = [];
      let totalPages = 1;
      for (let page = 1; page <= totalPages && page <= 50 && products.length < maxProducts; page++) {
        const url = `https://${host}/wp-json/wc/store/products?per_page=100&page=${page}`;
        let res: Response;
        try {
          // P1-03: resolved-host SSRF guard + manual-redirect revalidation.
          res = await safePublicFetch(url, { headers: { Accept: 'application/json' } }, { maxBytes: 50 * 1024 * 1024 });
        } catch {
          throw new HttpsError('unavailable', `Kunde inte nå ${host}.`);
        }
        if (!res.ok) {
          if (page === 1) throw new HttpsError('not-found', `${host} exponerar inget WooCommerce Store API (är det en WooCommerce-butik?).`);
          break;
        }
        totalPages = Number(res.headers.get('X-WP-TotalPages')) || totalPages;
        // The array is served as utf-8-sig; res.json() can choke on the BOM. Read
        // text, strip a leading BOM, then parse the BARE array.
        const text = (await res.text()).replace(/^﻿/, '');
        let batch: WooProduct[];
        try {
          batch = JSON.parse(text) as WooProduct[];
        } catch {
          if (page === 1) throw new HttpsError('not-found', `Ogiltigt svar från ${host} (inte WooCommerce Store API?).`);
          break;
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        products.push(...batch);
      }
      if (products.length === 0) throw new HttpsError('not-found', `Inga produkter hittades på ${host}.`);

      // ── 2. Existing products in the target shop: taken SKUs + already-imported
      //    Woo keys (RESUMABILITY — a re-run skips imported products; a mid-import
      //    timeout is harmless, just re-run). ──
      const existingSnap = await db.collection('products').where('shopId', '==', shopId).get();
      const takenSkus = new Set<string>();
      const importedWooKeys = new Set<string>();
      existingSnap.forEach((d) => {
        const data = d.data();
        const s = (data.sku || '').toString().trim().toLowerCase();
        if (s) takenSkus.add(s);
        if (data.wooKey) importedWooKeys.add(String(data.wooKey));
      });

      const bucket = getStorage().bucket();
      const reuploadImage = makeReuploadImage(bucket);

      // Gift cards are not real sellable products in our model — skip. The
      // remaining count is the progress-bar denominator.
      const candidates = products.slice(0, maxProducts).filter((p) => p.type !== 'gift-card');
      await writeProgress(migrationId, { total: candidates.length, phase: 'creating' });

      // ── 3. Transform + create each product. ──
      let created = 0;
      let imageFailures = 0;
      let alreadyImported = 0;
      let done = 0;
      const skipped: string[] = [];
      const droppedWooFields = [
        'inventory/stock', 'orders', 'customers', 'regular_price (compare pricing)',
        'gift-card products', 'brands', 'reviews/ratings', 'tags', 'weight/dimensions',
      ];

      for (const wp of candidates) {
       try {
        const name = decodeEntities((wp.name || '').trim());
        if (!name) { skipped.push('(namnlös produkt)'); done++; continue; }

        // RESUMABILITY: skip already-imported (by Woo product id) or a taken base sku.
        const wooKey = `id-${wp.id}`;
        const baseSku = skuFromName(name);
        if (importedWooKeys.has(wooKey) || takenSkus.has(baseSku.toLowerCase())) {
          alreadyImported++; done++; continue;
        }
        const productSku = uniqueSku(baseSku, takenSkus);
        takenSkus.add(productSku.toLowerCase());
        importedWooKeys.add(wooKey);

        const price = wooPrice(wp.prices);

        // Pre-upload this product's distinct images CONCURRENTLY (the deadline fix).
        const imgNs = `woo_${wp.id}`;
        const uploadedBySrc = new Map<string, string>();
        {
          const distinct: string[] = [];
          const seen = new Set<string>();
          (wp.images || []).forEach((im) => { const s = im?.src; if (s && !seen.has(s)) { seen.add(s); distinct.push(s); } });
          await Promise.all(distinct.map(async (src, idx) => {
            const url = await reuploadImage(src, `products/${shopId}/${imgNs}/img_${idx}`);
            if (url) uploadedBySrc.set(src, url);
            else imageFailures++;
          }));
        }
        const uploadedUrls = (wp.images || []).map((im) => uploadedBySrc.get(im.src)).filter(Boolean) as string[];
        const heroUrl = uploadedUrls[0] || '';
        const galleryUrls = uploadedUrls.slice(1);

        let cleanGroups: CleanGroup[] = [];
        let cleanVariants: VariantRow[] = [];

        if (wp.type === 'variable') {
          // Single size axis ('Storlek') → ONE implicit group (no colorway) whose
          // sizes are the size attribute's terms. deriveVariantsFromGroups builds
          // the ${sku}-${size} row SKUs (the cart/repricing money-path key).
          const sizeAttr = (wp.attributes || []).find((a) => a.has_variations);
          const sizes = (sizeAttr?.terms || []).map((t) => decodeEntities((t?.name || '').trim())).filter(Boolean);
          const rawGroups: RawGroup[] = [{
            label: name,           // implicit single group labelled by the product name
            price: '',             // inherit the product price
            images: heroUrl ? [heroUrl] : [],
            sizes,
          }];
          const derived = deriveVariantsFromGroups(rawGroups, { productSku, productPrice: price });
          cleanGroups = derived.cleanGroups;
          cleanVariants = derived.cleanVariants;
        }
        // simple (and anything non-variable) → plain product, no variants.

        const shortHtml = wp.short_description || '';
        const longHtml = wp.description || wp.short_description || '';
        const plain = shortHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const data: Record<string, unknown> = {
          name,
          sku: productSku,
          category: wooCategory(wp.categories),
          tags: [],
          hasVariants: cleanVariants.length > 0,
          variantGroups: cleanGroups,
          options: [],
          variants: cleanVariants,
          b2cPrice: price,
          basePrice: price,
          isActive: true,
          featured: false,
          imageUrl: heroUrl,
          b2cImageUrl: heroUrl,
          b2cImageGallery: galleryUrls,
          availability: { b2c: true },
          descriptions: { b2c: decodeEntities(plain).slice(0, 600), b2cMoreInfo: longHtml },
          isPersonalized: false,
          sizeGuide: '',
          weight: { value: 0, unit: 'g' },
          dimensions: { length: { value: 0, unit: 'mm' }, width: { value: 0, unit: 'mm' }, height: { value: 0, unit: 'mm' } },
          shipping: {
            sweden: { cost: 0, service: 'Standard' },
            nordic: { cost: 0, service: 'Nordic' },
            eu: { cost: 0, service: 'EU' },
            worldwide: { cost: 0, service: 'International' },
          },
          delivery: { shipping: true, pickup: true },
          shopId,
          migratedFrom: `woo:${host}`,
          wooKey,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        };

        await db.collection('products').add(data);
        created++;
        done++;
        if (done % 5 === 0) await writeProgress(migrationId, { done });
       } catch (e: any) {
        // One malformed product must never abort the whole import.
        skipped.push((wp?.name || `#${wp?.id ?? '?'}`).toString().slice(0, 80));
        done++;
        console.warn('migrateFromWoo: product skipped', wp?.id, e?.message);
       }
      }

      await writeProgress(migrationId, { done, phase: 'done' });

      return {
        success: true,
        source: host,
        productsFound: products.length,
        created,
        alreadyImported,
        imageFailures,
        skipped,
        droppedWooFields,
        note: 'Demo-import: endast publik katalog (produkter, varianter, priser, bilder). Lager, ordrar, kunder och tryckfiler ingår inte.',
      };
    } catch (e: any) {
      // Whole-import abort → stamp the status doc so the client bar shows the error,
      // then rethrow (HttpsError passes through unchanged).
      await writeProgress(migrationId, { phase: 'error', error: String(e?.message || e).slice(0, 300) });
      throw e;
    }
  }
);
