// ProductForm — the create/edit form for a shop's products, extracted from the
// old AdminProducts.jsx 4-tab monolith (2026-06-15 redesign).
//
// What changed vs the old inline form:
//  • ONE section (no Allmänt/B2B/B2C tabs). All info + images on one page.
//  • B2B removed entirely (reseller descriptions/images, EAN fields,
//    manufacturingCost, the B2B availability toggles).
//  • Translations removed: fields are plain Swedish strings. Existing products
//    that stored name/descriptions as per-locale objects ({'sv-SE': '...'}) are
//    READ-COMPATIBLE — plainText() pulls the Swedish value — but writes are
//    plain strings going forward. No data migration.
//  • ONE price field ("Pris, inkl. moms") that writes BOTH b2cPrice and
//    basePrice, because consumer price resolves as `b2cPrice || basePrice`
//    everywhere (incl. the server-side Stripe charge). Keeping both in sync
//    means the storefront + payment fallback always agree.
//  • Relaxed validation: nothing is hard-required (name still recommended; an
//    empty name just falls back to the SKU for display). No `*`/required attrs.
//  • availability.b2c defaults to true and is preserved (it's a live storefront
//    query filter: where('availability.b2c','==',true)).
//
// Product model v2 (2026-06-15, docs/PRODUCT_MODEL_V2.md):
//  • `group` → `category` (the browse taxonomy / URL driver). The old
//    productGroups side-collection + defaultProductId are gone.
//  • VARIANTS are embedded on the product: `variants: [{ sku, label, price,
//    image? }]`, gated by `hasVariants` (off by default). No more per-variant
//    product docs / shared group string. size/color top-level fields removed
//    (a variant's `label` carries the choice).
//
// Product model v2.1 (Shopify-style options, 2026-07-02):
//  • `options: [{ name, values: [{ value, image }] }]` (1–3 options, e.g.
//    Färg × Storlek, or a single Vikt for 500g/750g). The variant list is the
//    GENERATED matrix of all value combinations; each row keeps sku + price.
//  • Per-VALUE images (Shopify assigns one image per variant from the shared
//    gallery; we assign per option value — same effect, less repetition: the
//    red photo attaches to "Röd" once, not to every Röd size row).
//  • Each generated variant additionally stores `optionValues: ['Röd','S']`
//    (parallel to `options` order) and a derived `label` = values joined with
//    ' / ' — so the cart, order lines, e-mails and the server repricing
//    (createPaymentIntent matches by variant sku) are all unchanged.
//  • Legacy flat variants (no `options` field) auto-migrate when the product
//    is opened for edit: one option named "Variant" whose values are the old
//    labels; skus/prices/images are preserved.
//
// Product model v2.2 (variant rail, 2026-07-02 — supersedes the v2.1 admin UI):
//  • Admin edits `variantGroups`: one rail entry per distinct variant
//    (colorway/weight) with its own name, image, sku, price and OPTIONAL
//    per-variant sizes (sizes can differ between colorways).
//  • Save derives the sellable `variants` rows — one per (group × size), or
//    one for a sizeless group — with `{sku, label, price, image, group, size}`.
//    label = "Svart / M", per-size skus auto-append the size slug. The cart
//    and the server repricing keep matching rows by sku, unchanged.
//  • `options` is written as [] (the v2.1 matrix UI is retired); the
//    storefront still renders v2.1 docs until they're re-saved.
//  • Older products (flat v2.0 rows or v2.1 matrix rows) migrate on edit:
//    one rail group per row, sku/price/image preserved.
//
// Tenancy: create stamps shopId via withShopId(...) and the parent passes
// shopId from useShopId().
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, addDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { uploadImageToStorage } from '../../utils/imageUpload';
import { db, storage } from '../../firebase/config';
import toast from 'react-hot-toast';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import SortableImageGallery from './SortableImageGallery';
import { withShopId } from '../../config/withShopId';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import { listMappings } from '../../utils/podMappings';
import { priceFloor, sellerProfitExVat, sellerMargin, priceForMargin, roundUpTo9, FEE_RATE, FEE_FIXED } from '../../wagons/pod-wagon/podPricing';
import { CardSection, RightRail, Button } from './ui';
import { skuFromName, uniqueSku } from '../../utils/productUrls';
import { deriveVariantsFromGroups } from '../../utils/variantDerivation';
import { query, where, getDocs } from 'firebase/firestore';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isProductFeatured } from '../../utils/productSorting';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// Read a field that may be a legacy per-locale object or a plain string.
const plainText = (field) => {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object') {
    return field['sv-SE'] || Object.values(field).find((v) => typeof v === 'string') || '';
  }
  return '';
};

// ----- Variant-rail helpers (model v2.2) -----
//
// Admin edits `variantGroups` (the rail): one entry per distinct variant
// (colorway/weight/flavor) with its own image, sku, price and OPTIONAL sizes.
// Save DERIVES the sellable `variants` rows from the groups — one row per
// (group × size), or one row for a sizeless group — so the cart/server money
// paths keep matching by row sku exactly as before.

// Read persisted variantGroups into edit state. `images` in edit state is an
// ordered list of { url } (already uploaded) or { file, preview } (pending
// upload at save). Older docs with a single `image` string normalize to a
// one-entry list.
const normalizeGroups = (rawGroups) =>
  (Array.isArray(rawGroups) ? rawGroups : [])
    .filter((g) => g && (g.label || '').trim())
    .map((g) => ({
      label: g.label,
      sku: g.sku || '',
      price: g.price ?? '',   // null (inherited) reads back as empty field
      images: Array.isArray(g.images) && g.images.length > 0
        ? g.images.filter(Boolean).map((url) => ({ url }))
        : (g.image ? [{ url: g.image }] : []),
      sizes: Array.isArray(g.sizes) ? g.sizes.filter((s) => (s || '').trim()).map((s) => s.toUpperCase()) : [],
    }));

// Migrate older persisted shapes into rail groups:
//  • v2.0 legacy flat variants ({sku,label,price,image}) → one group per row.
//  • v2.1 options-matrix variants (rows with optionValues) → one group per
//    row, flattened (combos become individual rail entries the operator can
//    restructure). sku/price/image always survive.
// Duplicate/empty labels fall back to the sku so groups stay uniquely named.
const groupsFromLegacyVariants = (variants) => {
  const seen = new Set();
  const groups = [];
  for (const v of variants) {
    let label = (v.label || v.sku || '').trim();
    if (!label) continue;
    if (seen.has(label.toLowerCase())) label = `${label} (${v.sku})`;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    groups.push({
      label,
      sku: v.sku || '',
      price: v.price ?? '',
      images: v.image ? [{ url: v.image }] : [],
      sizes: [],
    });
  }
  return groups;
};

// A rail entry: click to select, drag by the grip to reorder. Drag listeners
// sit ONLY on the grip so they never swallow the select click.
const SortableRailItem = ({ id, selected, thumb, title, subtitle, onSelect }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }}
      className={isDragging ? 'z-10' : ''}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
        className={`flex min-w-[10rem] cursor-pointer items-center gap-1.5 rounded-[var(--radius-admin-el)] border p-2 text-left transition-all sm:min-w-0 ${
          selected
            ? 'border-[var(--color-admin-primary)] bg-admin-surface shadow-[var(--shadow-admin)]'
            : 'border-admin-border bg-admin-surface-2 opacity-60 hover:opacity-100'
        }`}
      >
        <span
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          title="Dra för att ändra ordning"
          className="cursor-grab touch-none text-admin-text-faint active:cursor-grabbing"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M7 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm8-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
          </svg>
        </span>
        {thumb ? (
          <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded-[4px] border border-admin-border bg-white object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[4px] border border-admin-border bg-admin-surface">
            <svg className="h-4 w-4 text-admin-text-faint" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Zm10.5-11.25h.008v.008h-.008V9.75Z" />
            </svg>
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-admin-text">{title}</span>
          {subtitle && <span className="block truncate text-[11px] text-admin-text-muted">{subtitle}</span>}
        </span>
      </div>
    </div>
  );
};

const emptyForm = () => ({
  id: '',
  name: '',
  sku: '',
  category: '',          // was `group`: the browse taxonomy / URL driver
  tags: [],
  price: 0,
  // "Ordinarie pris" (was-price) for a REA/sale. 0/empty = not on sale. When set
  // above the sale price, the storefront strikes it through + shows a Rea-badge.
  compareAtPrice: 0,
  // Wholesale price (B2B add-on). Distinct from the consumer price: the B2B
  // portal charges this (ex moms), the storefront never reads it. Persisted to
  // a NEW `b2bPrice` field — NOT basePrice (basePrice mirrors b2cPrice as the
  // consumer fallback). 0 = no wholesale price set. Only shown/saved when the
  // shop has the `b2b` add-on enabled.
  b2bPrice: 0,
  // Variants (model v2.2): the admin edits `variantGroups` (the rail — one
  // entry per colorway/weight with image/sku/price/sizes). The sellable
  // `variants` rows are DERIVED from the groups at save. hasVariants is
  // derived too: groups exist ⇒ true.
  hasVariants: false,
  variantGroups: [],
  variants: [],
  isActive: true,
  // Frontpage "Utvalt" flag (the star in the product list). Boolean going
  // forward; legacy products used the reserved tag `featured` instead.
  featured: false,
  imageUrl: '',
  b2cImageUrl: '',
  b2cImageGallery: [],
  launchDate: '',
  // b2c: live storefront query filter. b2b: wholesale-catalog filter (B2B
  // add-on). Both default-ON: a product without the key is available.
  availability: { b2c: true, b2b: true },
  // POD marker: a print-on-demand product MUST have a print connection
  // (podMappings row for its SKU) before it may go live in the storefront —
  // an unconnected POD product would take orders the printer never sees.
  // Stamped true by Design Studio on publish; editable here to mark legacy
  // products created before the automatic flow.
  isPodProduct: false,
  descriptions: { b2c: '', b2cMoreInfo: '' },
  // Right-of-withdrawal (POD). A "personalized" / made-to-order product (buyer
  // supplies own image/text/measurements) is a specialtillverkad vara → consumer
  // ångerrätt (14-day withdrawal) does NOT apply, IF disclosed + consented at
  // checkout. Default false = a normal standard-options product WITH withdrawal.
  isPersonalized: false,
  // Optional per-product size guide (rich text). Shown on the product page and
  // referenced by the no-withdrawal notice for size-dependent products.
  sizeGuide: '',
  weight: { value: 0, unit: 'g' },
  dimensions: {
    length: { value: 0, unit: 'mm' },
    width: { value: 0, unit: 'mm' },
    height: { value: 0, unit: 'mm' },
  },
  shipping: {
    sweden: { cost: 0, service: 'Standard' },
    nordic: { cost: 0, service: 'Nordic' },
    eu: { cost: 0, service: 'EU' },
    worldwide: { cost: 0, service: 'International' },
  },
  // Per-product delivery modes (Delivery & Pickup v2). Both default ON, so a
  // product without this field behaves exactly as before: shippable AND
  // pickup-eligible. At least one must stay on (a product no one can receive
  // makes no sense) — enforced at save time.
  delivery: { shipping: true, pickup: true },
});

// Build the rail edit state from a product doc. v2.2 products persist
// `variantGroups`; anything older (flat v2.0 variants or v2.1 options-matrix
// rows) is migrated into groups so the same editor serves every product.
const variantStateFromProduct = (p) => {
  const groups = normalizeGroups(p.variantGroups);
  if (groups.length > 0) return { variantGroups: groups };
  const persisted = Array.isArray(p.variants) ? p.variants.filter((v) => v) : [];
  return { variantGroups: groupsFromLegacyVariants(persisted) };
};

// Build the form state from an existing product doc (read-compatible).
const formFromProduct = (p) => ({
  ...emptyForm(),
  id: p.id || '',
  name: plainText(p.name),
  sku: p.sku || '',
  // category: prefer the new field, fall back to the old `group` (so any
  // pre-existing test product still shows its taxonomy when edited).
  category: p.category || p.group || '',
  tags: Array.isArray(p.tags) ? p.tags : [],
  // Single price sourced from the consumer price (b2cPrice || basePrice).
  price: p.b2cPrice || p.basePrice || 0,
  // Was-price for a REA. Read as empty when 0/unset so the field shows blank.
  compareAtPrice: p.compareAtPrice || '',
  // Wholesale price (B2B add-on). Read straight from b2bPrice; 0 if unset.
  b2bPrice: p.b2bPrice || 0,
  hasVariants: !!p.hasVariants && Array.isArray(p.variants) && p.variants.length > 0,
  ...variantStateFromProduct(p),
  isActive: p.isActive ?? true,
  // Boolean wins; the legacy `featured` tag only counts while it's unset.
  featured: isProductFeatured(p),
  imageUrl: p.imageUrl || '',
  b2cImageUrl: p.b2cImageUrl || '',
  b2cImageGallery: Array.isArray(p.b2cImageGallery) ? p.b2cImageGallery : [],
  launchDate: p.launchDate
    ? new Date(p.launchDate.toDate ? p.launchDate.toDate() : p.launchDate).toISOString().slice(0, 16)
    : '',
  availability: { b2c: p.availability?.b2c !== false, b2b: p.availability?.b2b !== false },
  isPodProduct: p.isPodProduct === true,
  // Right-of-withdrawal: default false (a normal product retains 14-day withdrawal).
  isPersonalized: p.isPersonalized === true,
  sizeGuide: p.sizeGuide || '',
  descriptions: {
    b2c: plainText(p.descriptions?.b2c),
    b2cMoreInfo: plainText(p.descriptions?.b2cMoreInfo),
  },
  weight: { value: p.weight?.value || 0, unit: p.weight?.unit || 'g' },
  dimensions: {
    length: { value: p.dimensions?.length?.value || 0, unit: p.dimensions?.length?.unit || 'mm' },
    width: { value: p.dimensions?.width?.value || 0, unit: p.dimensions?.width?.unit || 'mm' },
    height: { value: p.dimensions?.height?.value || 0, unit: p.dimensions?.height?.unit || 'mm' },
  },
  shipping: {
    sweden: { cost: p.shipping?.sweden?.cost || 0, service: p.shipping?.sweden?.service || 'Standard' },
    nordic: { cost: p.shipping?.nordic?.cost || 0, service: p.shipping?.nordic?.service || 'Nordic' },
    eu: { cost: p.shipping?.eu?.cost || 0, service: p.shipping?.eu?.service || 'EU' },
    worldwide: { cost: p.shipping?.worldwide?.cost || 0, service: p.shipping?.worldwide?.service || 'International' },
  },
  // Default-ON read: a product without `delivery` (every product before this
  // feature) is treated as both shippable and pickup-eligible. Only an explicit
  // `false` turns a mode off.
  delivery: {
    shipping: p.delivery?.shipping !== false,
    pickup: p.delivery?.pickup !== false,
  },
});

/**
 * @param {object|null} product   the product being edited, or null to create
 * @param {string} shopId         the active shop (tenancy)
 * @param {string[]} availableCategories  existing category names (autocomplete)
 * @param {string[]} availableTags    existing tag names across the shop (autocomplete)
 * @param {() => void} onSaved     called after a successful save (parent reloads + closes)
 * @param {() => void} onCancel    close without saving
 * @param {string} [formId]        id put on the <form>. Lets the HOST render a
 *   Spara button in the Page header — outside this form's DOM — via the native
 *   `form="<id>"` attribute, so the header CTA submits this exact form with no
 *   ref plumbing or duplicated submit logic.
 * @param {(saving:boolean) => void} [onSavingChange]  mirrors `saving` to the
 *   host so a header button can disable/relabel in step with the bottom one.
 */
const ProductForm = ({ product, shopId, availableCategories = [], availableTags = [], onSaved, onCancel, formId, onSavingChange }) => {
  const [formData, setFormData] = useState(() => (product ? formFromProduct(product) : emptyForm()));
  const [saving, setSaving] = useState(false);
  // Mirror `saving` to the host (header Spara). The cleanup matters: on a
  // SUCCESSFUL save the form unmounts via onSaved() without ever setting
  // saving=false (only the catch does), so without this the host's flag stayed
  // true and the next product opened with a disabled "Sparar…" header button.
  // Cancel/unmount takes the same path.
  useEffect(() => {
    onSavingChange?.(saving);
    return () => onSavingChange?.(false);
  }, [saving, onSavingChange]);

  // B2B Wholesale add-on: gates the wholesale-price field. Default-ON for shops
  // without a `features` map, but nothing else in this form depends on it, so a
  // non-B2B shop simply never sees the extra field.
  const { isEnabled } = useShopFeatures();
  const b2bEnabled = isEnabled('b2b');
  const podEnabled = isEnabled('pod');

  // ── POD live-gate state ────────────────────────────────────────────────────
  // The SKUs that have a print connection (podMappings). null = not loaded yet.
  // Connection is checked against the SAVED product's SKUs (mappings key on what
  // is in the database, not on unsaved form edits).
  const [podMappingSkus, setPodMappingSkus] = useState(null);
  useEffect(() => {
    if (!podEnabled || !shopId) return;
    let alive = true;
    listMappings(shopId)
      .then((ms) => { if (alive) setPodMappingSkus(new Set(ms.map((m) => m.sku).filter(Boolean))); })
      .catch(() => { if (alive) setPodMappingSkus(new Set()); });
    return () => { alive = false; };
  }, [podEnabled, shopId]);
  // Coverage rule (matches the print pipeline's longest-prefix resolution): the
  // PARENT sku's mapping is the fallback for every colour, so parent-mapped =
  // fully covered. Without a parent row, EVERY variant-group sku must be mapped
  // — one override row alone must never count as "connected" (P1 2026-08-15).
  const podCoverage = (parentSku, groupSkus, mappingSkus) => {
    if (!mappingSkus) return false; // not loaded → fail closed
    if (parentSku && mappingSkus.has(parentSku)) return true;
    const groups = (groupSkus || []).filter(Boolean);
    return groups.length > 0 && groups.every((sku) => mappingSkus.has(sku));
  };
  const podConnected = product
    ? podCoverage(
        product.sku,
        Array.isArray(product.variantGroups) ? product.variantGroups.map((g) => g?.sku) : [],
        podMappingSkus
      )
    : false;
  // Gate: a POD product without a connection can be SAVED but never LIVE.
  // (Only asserted once mappings have loaded — no false alarm during the fetch.)
  const podGateActive = podEnabled && formData.isPodProduct && podMappingSkus !== null && !podConnected;
  // Break-even price floor (podPricing.js) — computable when the Studio stamped
  // the template's cost on the product. Legacy POD products without the stamp
  // simply get no floor here (the Studio enforces it on their next publish).
  const podFloor = podEnabled && formData.isPodProduct && Number.isFinite(product?.podCostSek)
    ? priceFloor(product.podCostSek)
    : null;
  // Margin target for the "räkna fram ett pris"-verktyget under prisfältet. Pure
  // UI state — it never leaves the form; only the button writes formData.price.
  // 40 % matches the Studio's default so the two surfaces suggest the same price.
  const [podMarginTarget, setPodMarginTarget] = useState('40');

  // Main B2C image.
  const [mainImageFile, setMainImageFile] = useState(null);
  const [mainImagePreview, setMainImagePreview] = useState(product?.b2cImageUrl || product?.imageUrl || null);

  // Gallery: existing (URLs, reorderable) + new (files to upload).
  const [existingGallery, setExistingGallery] = useState(
    Array.isArray(product?.b2cImageGallery) ? product.b2cImageGallery : []
  );
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [galleryPreviews, setGalleryPreviews] = useState([]);

  // Category autocomplete (the browse taxonomy / URL driver; was `group`).
  const [categoryInput, setCategoryInput] = useState(product?.category || product?.group || '');
  const [showCategorySuggestions, setShowCategorySuggestions] = useState(false);
  const [filteredCategories, setFilteredCategories] = useState([]);

  // Tags: a chip input with autocomplete. tags = light filter labels (e.g.
  // `featured`), distinct from `category` (the browse taxonomy) and from
  // `variants` (sizes/colours of THIS product).
  const [tagInput, setTagInput] = useState('');
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);

  const addTag = (raw) => {
    const tag = (raw ?? tagInput).trim();
    if (!tag) return;
    if (!formData.tags.includes(tag)) setField('tags', [...formData.tags, tag]);
    setTagInput('');
    setShowTagSuggestions(false);
  };
  const removeTag = (tag) => setField('tags', formData.tags.filter((t) => t !== tag));
  // Suggestions = shop tags not already on this product, matching the input.
  const tagSuggestions = availableTags
    .filter((t) => !formData.tags.includes(t) && (!tagInput.trim() || t.toLowerCase().includes(tagInput.toLowerCase())));

  // Revoke object URLs on unmount to avoid leaks.
  useEffect(() => {
    return () => {
      if (mainImagePreview && mainImagePreview.startsWith('blob:')) URL.revokeObjectURL(mainImagePreview);
      galleryPreviews.forEach((u) => u.startsWith('blob:') && URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = (name, value) => setFormData((prev) => ({ ...prev, [name]: value }));

  // SKU is the product's lookup key (URL, cart, checkout, POD). We auto-derive
  // it from the title so a product is never saved unreachable — but only while
  // the operator hasn't hand-edited SKU (then their value wins). An EXISTING
  // product that already has a SKU counts as "already set" (never silently
  // rewrites a live SKU, which would break its URL).
  const skuTouchedRef = React.useRef(Boolean(product && (formData.sku || '').trim()));

  const handleInput = (e) => {
    const { name, value, type, checked } = e.target;
    if (type === 'checkbox') { setField(name, checked); return; }
    if (type === 'number') { setField(name, parseFloat(value) || 0); return; }
    if (name === 'sku') {
      // Any keystroke in SKU = the operator owns it from now on (empty included).
      skuTouchedRef.current = true;
      setField('sku', value);
      return;
    }
    if (name === 'name') {
      // Auto-fill SKU from the title while SKU is still auto-managed.
      setFormData((prev) => ({
        ...prev,
        name: value,
        sku: skuTouchedRef.current ? prev.sku : skuFromName(value),
      }));
      return;
    }
    setField(name, value);
  };

  // ----- category autocomplete -----
  const onCategoryChange = (e) => {
    const v = e.target.value;
    setCategoryInput(v);
    setField('category', v);
    if (v.trim()) {
      const f = availableCategories.filter((g) => g.toLowerCase().includes(v.toLowerCase()));
      setFilteredCategories(f);
      setShowCategorySuggestions(f.length > 0);
    } else {
      setFilteredCategories([]);
      setShowCategorySuggestions(false);
    }
  };
  const pickCategory = (g) => {
    setCategoryInput(g);
    setField('category', g);
    setShowCategorySuggestions(false);
  };

  // ----- variants (rail of groups, model v2.2) -----

  // Which rail entry is open in the editor panel.
  const [selectedGroupIdx, setSelectedGroupIdx] = useState(0);
  // Draft text of the selected panel's "add size" input.
  const [sizeInput, setSizeInput] = useState('');

  const updateGroup = (idx, patch) =>
    setField('variantGroups', formData.variantGroups.map((g, i) => (i === idx ? { ...g, ...patch } : g)));

  const addGroup = () => {
    // Prefill sizes from the previous variant — the common case is "same size
    // run for every colorway", so a new variant costs zero extra size clicks.
    const prev = formData.variantGroups[formData.variantGroups.length - 1];
    const next = {
      label: '',
      sku: '',
      price: '',
      images: [],
      sizes: prev ? [...prev.sizes] : [],
    };
    // FIRST variant on a product: the product as already published IS variant
    // number one. Seed it as "Original" (name editable) with NO images of its
    // own — an imageless variant shows the product's base images on the
    // storefront, so Original stays in sync with the main post's gallery
    // (adding images to the product later reaches Original automatically).
    // Price/sku stay empty = inherit/auto.
    if (formData.variantGroups.length === 0) {
      const original = {
        label: 'Original',
        sku: '',
        price: '',
        images: [],
        sizes: [],
      };
      setField('variantGroups', [original, next]);
      setSelectedGroupIdx(1);
      setSizeInput('');
      return;
    }
    setField('variantGroups', [...formData.variantGroups, next]);
    setSelectedGroupIdx(formData.variantGroups.length);
    setSizeInput('');
  };

  // Per-variant image list: append device files (uploaded at save) or an
  // existing gallery URL; remove by position. First image = the variant's
  // primary (shown in the rail, swapped in on the storefront).
  const addGroupImageFiles = (idx, files) => {
    const ok = [];
    for (const f of files) {
      if (f.size > MAX_IMAGE_SIZE) {
        toast.error(`${f.name} är för stor. Max ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`);
        continue;
      }
      ok.push({ file: f, preview: URL.createObjectURL(f) });
    }
    if (ok.length === 0) return;
    const g = formData.variantGroups[idx];
    if (g) updateGroup(idx, { images: [...g.images, ...ok] });
  };
  const addGroupImageUrl = (idx, url) => {
    const g = formData.variantGroups[idx];
    if (!g || g.images.some((im) => im.url === url)) return;
    updateGroup(idx, { images: [...g.images, { url }] });
  };
  const removeGroupImage = (idx, imgIdx) => {
    const g = formData.variantGroups[idx];
    if (g) updateGroup(idx, { images: g.images.filter((_, i) => i !== imgIdx) });
  };

  // Rail drag-reorder (grip handle). Selection follows the moved item.
  const railSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onRailDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    setFormData((prev) => ({ ...prev, variantGroups: arrayMove(prev.variantGroups, from, to) }));
    setSelectedGroupIdx((cur) => arrayMove(formData.variantGroups.map((_, i) => i), from, to).indexOf(cur));
  };

  const removeGroup = (idx) => {
    const doomed = formData.variantGroups[idx];
    // A configured variant (name/images/sizes) is real work — confirm before
    // discarding. A freshly added empty row is removed without fuss.
    const configured = doomed && ((doomed.label || '').trim() || doomed.images.length > 0 || doomed.sizes.length > 0);
    if (configured && !window.confirm(`Ta bort varianten "${(doomed.label || '').trim() || 'utan namn'}"? Detta går inte att ångra efter att du sparat.`)) {
      return;
    }
    const nextGroups = formData.variantGroups.filter((_, i) => i !== idx);
    setField('variantGroups', nextGroups);
    setSelectedGroupIdx((cur) => Math.max(0, Math.min(cur > idx ? cur - 1 : cur, nextGroups.length - 1)));
    setSizeInput('');
  };

  // Sizes on the SELECTED group. Accepts a pasted comma-list ("S, M, L").
  // Normalized to UPPERCASE ("xl" → "XL") so the size run reads consistently
  // in the shop, the cart and on order lines.
  const addSizes = (idx) => {
    const parts = sizeInput.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    setSizeInput('');
    if (parts.length === 0) return;
    const g = formData.variantGroups[idx];
    if (!g) return;
    const taken = new Set(g.sizes.map((s) => s.toLowerCase()));
    const fresh = [];
    for (const s of parts) {
      if (taken.has(s.toLowerCase())) continue;
      taken.add(s.toLowerCase());
      fresh.push(s);
    }
    if (fresh.length > 0) updateGroup(idx, { sizes: [...g.sizes, ...fresh] });
  };
  const removeSize = (idx, size) => {
    const g = formData.variantGroups[idx];
    if (g) updateGroup(idx, { sizes: g.sizes.filter((s) => s !== size) });
  };

  // ----- images -----
  const onMainImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error(`Bilden är för stor. Max ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`);
      return;
    }
    setMainImagePreview(URL.createObjectURL(file));
    setMainImageFile(file);
  };

  const onGalleryChange = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > MAX_IMAGE_SIZE);
    if (tooBig.length) {
      toast.error(`${tooBig.length} filer är för stora. Max ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`);
      return;
    }
    setGalleryPreviews((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))]);
    setGalleryFiles((prev) => [...prev, ...files]);
  };

  // Promote an ALREADY-UPLOADED gallery image (studio mockups land here) to
  // Huvudbild. Save reads `formData.b2cImageUrl` unless a NEW file was picked,
  // so clearing mainImageFile is what makes this stick.
  const useAsMainImage = (url) => {
    setMainImageFile(null);
    setMainImagePreview(url);
    setFormData((prev) => ({ ...prev, b2cImageUrl: url, imageUrl: url }));
    toast.success('Huvudbild vald — spara för att bekräfta.');
  };

  const removeNewGalleryImage = (index) => {
    setGalleryPreviews((prev) => prev.filter((_, i) => i !== index));
    setGalleryFiles((prev) => prev.filter((_, i) => i !== index));
  };
  // Removing from the gallery is a VIEW edit only. Which files actually get
  // deleted from Storage is resolved at SUBMIT time (see handleSubmit): a
  // click-time queue cannot know the final state — the studio's hero is both
  // huvudbild and a gallery member, and a later "Använd som huvudbild" pick can
  // orphan or rescue a file after the click.
  const removeExistingGalleryImage = (index) => {
    setExistingGallery((prev) => prev.filter((_, i) => i !== index));
  };

  const deleteImageFromStorage = async (imageUrl) => {
    try {
      const url = new URL(imageUrl);
      const pathStart = url.pathname.indexOf('/o/') + 3;
      const pathEnd = url.pathname.indexOf('?');
      const storagePath = decodeURIComponent(url.pathname.substring(pathStart, pathEnd));
      await deleteObject(ref(storage, storagePath));
    } catch (err) {
      console.error('Error deleting image from storage:', err);
      // non-fatal — continue
    }
  };

  // ----- save -----
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    // Per-product delivery modes: at least one must be on, otherwise the product
    // can't be received by any method (and checkout would have no valid option).
    if (!formData.delivery?.shipping && !formData.delivery?.pickup) {
      toast.error('Välj minst ett leveranssätt (hemleverans eller upphämtning).');
      return;
    }

    // POD price floor (break-even, podPricing.js): a price below it means the
    // seller LOSES money on every sale — block, name the floor, name the fix.
    if (podFloor != null) {
      // ANY price below the floor blocks — 0 kr included (a "free" POD product
      // means the seller pays the platform's base cost on every order).
      const mainPrice = parseFloat(formData.price) || 0;
      if (mainPrice < podFloor) {
        toast.error(`Priset ${mainPrice} kr ligger under prisgolvet ${podFloor} kr — vid golvet tjänar du 0 kr. Höj priset.`);
        return;
      }
      const lowGroups = (formData.variantGroups || [])
        .filter((g) => String(g?.price ?? '').trim() !== '' && Number.isFinite(parseFloat(g.price)) && parseFloat(g.price) < podFloor)
        .map((g) => g.label || g.sku || 'variant');
      if (lowGroups.length > 0) {
        toast.error(`Priset för ${lowGroups.join(', ')} ligger under prisgolvet ${podFloor} kr.`);
        return;
      }
    }

    // SKU is the lookup key (URL/cart/checkout/POD). Guarantee a non-empty,
    // per-shop-UNIQUE SKU before saving — auto-derive from the title if the
    // field is empty; block save only if there's no title to derive from.
    let resolvedSku = (formData.sku || '').trim();
    if (!resolvedSku) resolvedSku = skuFromName(formData.name);
    if (!resolvedSku || resolvedSku === 'produkt') {
      // skuFromName returns 'produkt' only when the name is empty/unusable.
      if (!(formData.name || '').trim()) {
        toast.error('Ange en titel eller ett SKU – produkten behöver ett unikt artikelnummer för sin webbadress.');
        return;
      }
    }

    setSaving(true);
    try {
      const productId = product ? (product.documentId || product.id || formData.id) : `prod_${Date.now()}`;

      // Enforce per-shop SKU uniqueness (collision = two products on one URL /
      // cart line). Load this shop's existing SKUs and de-dupe, excluding this
      // product's own current SKU when editing.
      const skuSnap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
      const takenSkus = [];
      skuSnap.forEach((docSnap) => {
        if (docSnap.id === productId) return; // ignore self (edit)
        const s = (docSnap.data().sku || '').trim();
        if (s) takenSkus.push(s);
      });
      const requestedSku = resolvedSku;
      resolvedSku = uniqueSku(resolvedSku, takenSkus, product ? (formData.sku || '') : '');
      if (resolvedSku !== requestedSku) {
        // Not silent: the operator may rely on the exact SKU externally.
        toast(`SKU "${requestedSku}" används redan av en annan produkt — sparas som "${resolvedSku}".`, { icon: '⚠️' });
      }

      // Resolve images.
      let mainImageUrl = formData.b2cImageUrl;
      if (mainImageFile) {
        mainImageUrl = await uploadImageToStorage(mainImageFile, `products/${shopId}/${productId}`, 'b2c_main');
      }

      let gallery = [...existingGallery];
      for (let i = 0; i < galleryFiles.length; i++) {
        const u = await uploadImageToStorage(galleryFiles[i], `products/${shopId}/${productId}`, `b2c_gallery_${Date.now()}_${i}`);
        gallery.push(u);
      }
      // Orphan sweep: delete every image the product ARRIVED with that survives
      // in neither the final gallery nor the final main image. Resolving here
      // (instead of queueing on each remove click) is what makes re-picking the
      // huvudbild safe in both directions — promoting a gallery image rescues
      // it, and replacing the old huvudbild collects it.
      const keptUrls = new Set([...gallery, mainImageUrl, formData.imageUrl].filter(Boolean));
      const originalUrls = [
        product?.b2cImageUrl,
        product?.imageUrl,
        ...(Array.isArray(product?.b2cImageGallery) ? product.b2cImageGallery : []),
      ].filter(Boolean);
      for (const url of new Set(originalUrls)) {
        if (!keptUrls.has(url)) await deleteImageFromStorage(url);
      }

      const price = parseFloat(formData.price) || 0;
      // Was-price for a REA. Only persist a genuine sale (> the selling price);
      // anything else stores 0 (= not on sale), so a stale/lower value never shows.
      const compareAtRaw = parseFloat(formData.compareAtPrice);
      const compareAtPrice = Number.isFinite(compareAtRaw) && compareAtRaw > price ? compareAtRaw : 0;
      const b2bPrice = parseFloat(formData.b2bPrice) || 0;

      // Variants (v2.2): upload any pending per-variant images, persist the
      // cleaned rail (`variantGroups`), then DERIVE the sellable rows — one
      // per (group × size), or one for a sizeless group. Empty group sku/price
      // auto-derive (sku from product-sku + label slug, price from the product
      // price); per-size row skus append the size slug. All row skus are made
      // unique within the product (server repricing + cart lineId key on them).
      const editedGroups = formData.variantGroups.filter((g) => (g.label || '').trim());
      // A nameless group with ANY data entered (sku/price/image/sizes) is a
      // mistake to surface, not to silently drop. A fully empty one (just
      // clicked "+ Lägg till variant") is dropped without fuss.
      const namelessWithData = formData.variantGroups.some(
        (g) => !(g.label || '').trim() && ((g.sku || '').trim() || g.images.length > 0 || g.sizes.length > 0 || parseFloat(g.price) > 0)
      );
      if (namelessWithData) {
        toast.error('Varje variant behöver ett namn.');
        setSaving(false);
        return;
      }
      const labelSeen = new Set();
      for (const g of editedGroups) {
        const key = g.label.trim().toLowerCase();
        if (labelSeen.has(key)) {
          toast.error(`Två varianter heter "${g.label.trim()}" — ge dem olika namn.`);
          setSaving(false);
          return;
        }
        labelSeen.add(key);
      }

      // Resolve each group's images first (the one async step: upload pending
      // files in list order, keep already-uploaded URLs), then hand the
      // resolved groups to the shared PURE derivation so this and the Design
      // Studio publish wizard produce byte-identical rows. Money paths key on
      // the row sku — see utils/variantDerivation.js.
      const resolvedGroups = [];
      for (const g of editedGroups) {
        const label = g.label.trim();
        const images = [];
        for (let i = 0; i < g.images.length; i++) {
          const im = g.images[i];
          if (im.url) {
            images.push(im.url);
          } else if (im.file) {
            images.push(await uploadImageToStorage(im.file, `products/${shopId}/${productId}`, `variant_${skuFromName(label)}_${i}`));
          }
        }
        resolvedGroups.push({ ...g, images });
      }
      const { cleanGroups, cleanVariants } = deriveVariantsFromGroups(resolvedGroups, {
        productSku: resolvedSku,
        productPrice: price,
        skuFromName,
      });

      // POD LIVE-GATE, decided on the SKUs BEING SAVED (P1 fix 2026-08-15: the
      // render-time check uses the SAVED sku, so editing the SKU could carry a
      // stale "connected" verdict onto skus the Print Queue will never find).
      // Mappings are fetched fresh if the initial load hasn't landed.
      let podConnectedFinal = false;
      if (podEnabled && formData.isPodProduct === true) {
        let mappingSkus = podMappingSkus;
        if (mappingSkus === null) {
          try {
            mappingSkus = new Set((await listMappings(shopId)).map((m) => m.sku).filter(Boolean));
          } catch {
            mappingSkus = new Set(); // unreadable → fail closed (draft)
          }
        }
        podConnectedFinal = podCoverage(resolvedSku, cleanGroups.map((g) => g?.sku), mappingSkus);
      }
      const hasVariants = cleanVariants.length > 0;

      // Build the persisted doc. Single price → BOTH consumer-price fields.
      const data = {
        name: formData.name,            // plain string going forward
        sku: resolvedSku,               // guaranteed non-empty + per-shop-unique
        category: formData.category,    // browse taxonomy / URL driver (was `group`)
        tags: formData.tags,
        hasVariants,
        variantGroups: cleanGroups,
        // v2.1 options-matrix is superseded by the rail — cleared on save so
        // the storefront renders the grouped picker for re-saved products.
        options: [],
        variants: cleanVariants,
        b2cPrice: price,
        basePrice: price,               // keep in sync for the `b2cPrice || basePrice` fallback
        compareAtPrice,                 // was-price for a REA (0 = not on sale)
        // Wholesale price — only written for B2B shops (a non-B2B shop's
        // products never gain the field). NOT folded into base/b2cPrice.
        ...(b2bEnabled ? { b2bPrice } : {}),
        isActive: formData.isActive,
        // Always written so the boolean supersedes the legacy `featured` tag.
        featured: formData.featured === true,
        imageUrl: mainImageUrl || formData.imageUrl || '',
        b2cImageUrl: mainImageUrl || '',
        b2cImageGallery: gallery,
        // POD marker — always written so unchecking persists.
        isPodProduct: formData.isPodProduct === true,
        availability: {
          // LIVE-GATE (enforced at save, not only in the UI): an unconnected POD
          // product is never written live. podMappingSkus === null (load raced
          // the save) counts as unconnected — fail CLOSED, the seller can re-save
          // once the connection exists.
          b2c: formData.availability.b2c !== false
            && !(podEnabled && formData.isPodProduct === true && !podConnectedFinal),
          // Only carry the b2b availability flag for B2B shops, so a non-B2B
          // shop's products never gain a stray key.
          ...(b2bEnabled ? { b2b: formData.availability.b2b !== false } : {}),
        },
        descriptions: {
          b2c: formData.descriptions.b2c || '',
          b2cMoreInfo: formData.descriptions.b2cMoreInfo || '',
        },
        // Right-of-withdrawal (POD): always written so toggling OFF persists
        // (a product can move from personalized → standard). Size guide is
        // free text; empty string when unset.
        isPersonalized: formData.isPersonalized === true,
        sizeGuide: formData.sizeGuide || '',
        weight: formData.weight,
        dimensions: formData.dimensions,
        shipping: formData.shipping,
        // Per-product delivery modes (validated above: at least one is true).
        delivery: { shipping: !!formData.delivery?.shipping, pickup: !!formData.delivery?.pickup },
        updatedAt: serverTimestamp(),
      };

      if (formData.launchDate) data.launchDate = new Date(formData.launchDate);

      if (!product) {
        data.createdAt = serverTimestamp();
        await addDoc(collection(db, 'products'), withShopId(data, shopId));
        toast.success('Produkt tillagd');
      } else {
        if (!productId || !String(productId).trim()) {
          toast.error('Fel: Produkt-ID saknas. Ladda om sidan.');
          setSaving(false);
          return;
        }
        const docRef = doc(db, 'products', productId);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          await updateDoc(docRef, data);
        } else {
          await setDoc(docRef, withShopId({ ...data, createdAt: serverTimestamp() }, shopId));
        }
        toast.success('Produkt uppdaterad');
      }

      if (formData.availability.b2c !== false && podEnabled && formData.isPodProduct === true && !podConnectedFinal) {
        toast('Sparad som utkast — produkten visas i webbshoppen först när tryckkopplingen finns.', { icon: '🔒' });
      }
      onSaved?.();
    } catch (err) {
      console.error('Error saving product:', err);
      toast.error('Misslyckades med att spara produkten');
      setSaving(false);
    }
  };

  const labelCls = 'block text-[13px] font-medium text-admin-text mb-1';
  const inputCls =
    'w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';

  const checkboxCls = 'h-4 w-4 rounded-[4px] border-admin-border text-[var(--color-admin-primary)] focus:ring-[var(--color-admin-primary)]';
  const helpCls = 'mt-1 text-[12px] text-admin-text-muted';

  return (
    <form id={formId} onSubmit={handleSubmit}>
      <RightRail
        main={
          <>
            {/* Title + SKU + Description — Shopify groups title/description at the very top */}
            <CardSection bodyClassName="space-y-4">
              <div>
                <label className={labelCls}>Titel</label>
                <input name="name" value={formData.name} onChange={handleInput} placeholder="t.ex. Gravad Lax" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>SKU (Artikelnummer)</label>
                <input name="sku" value={formData.sku} onChange={handleInput} placeholder="t.ex. LAX-500" className={inputCls} />
                <p className="mt-1 text-[12px] text-admin-text-muted">
                  Skapas automatiskt från titeln. Används i produktens webbadress – måste vara unik. Kan ändras.
                </p>
              </div>
              <div>
                <label className={labelCls}>Beskrivning</label>
                <textarea
                  rows={3}
                  value={formData.descriptions.b2c}
                  onChange={(e) => setField('descriptions', { ...formData.descriptions, b2c: e.target.value })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Mer information</label>
                <ReactQuill
                  theme="snow"
                  value={formData.descriptions.b2cMoreInfo}
                  onChange={(content) => setField('descriptions', { ...formData.descriptions, b2cMoreInfo: content })}
                  className="rounded-[var(--radius-admin-el)] bg-admin-surface"
                />
              </div>
              <div>
                <label className={labelCls}>Storleksguide (valfritt)</label>
                <textarea
                  rows={4}
                  value={formData.sizeGuide}
                  onChange={(e) => setField('sizeGuide', e.target.value)}
                  placeholder="t.ex. mått per storlek (S/M/L), mätinstruktioner…"
                  className={inputCls}
                />
                <p className={helpCls}>Visas på produktsidan. Viktigt för storleksberoende produkter — hjälper kunden välja rätt och styrker att specialtillverkning godkändes på rätt grunder.</p>
              </div>
            </CardSection>

            {/* Media */}
            <CardSection title="Media" bodyClassName="space-y-4">
              {/* Content-first flow (way 2, 2026-08-09): a saved product without
                  imagery can get its mockups + print connection from the Design
                  Studio — deep-links with this product preselected as target. */}
              {isEnabled('pod') && product && (product.documentId || product.id) && (
                <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-3 py-2.5">
                  <span className="min-w-0 flex-1 text-[12px] text-admin-text-muted">
                    Vill du skapa produktbilder från ett tryckmotiv? Designa i studion så
                    kopplas bilderna och trycket till den här produkten.
                  </span>
                  <Link
                    to={`/admin/pod?designFor=${product.documentId || product.id}`}
                    className="shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border px-3 py-1.5 text-[12px] font-medium text-admin-text hover:bg-admin-surface"
                  >
                    Skapa bilder i Design Studio
                  </Link>
                </div>
              )}
              <div>
                <label className={labelCls}>Huvudbild (max 5MB)</label>
                <div className="flex flex-col items-start gap-4 lg:flex-row lg:items-center">
                  <input type="file" accept="image/*" onChange={onMainImageChange} className="block w-full text-[13px] text-admin-text-muted file:mr-4 file:rounded-[var(--radius-admin-el)] file:border-0 file:bg-admin-surface-2 file:px-4 file:py-2 file:text-[13px] file:font-medium file:text-admin-text" />
                  {mainImagePreview && (
                    <img src={mainImagePreview} alt="Förhandsvisning" className="h-32 w-32 shrink-0 rounded-[var(--radius-admin-el)] border border-admin-border object-cover" />
                  )}
                </div>
              </div>
              <div>
                <label className={labelCls}>Bildgalleri (flera bilder, max 5MB/bild)</label>
                <div className="space-y-4">
                  <input type="file" accept="image/*" multiple onChange={onGalleryChange} className="block w-full text-[13px] text-admin-text-muted file:mr-4 file:rounded-[var(--radius-admin-el)] file:border-0 file:bg-admin-surface-2 file:px-4 file:py-2 file:text-[13px] file:font-medium file:text-admin-text" />
                  {existingGallery.length > 0 && (
                    <SortableImageGallery
                      images={existingGallery.map((url, index) => ({ id: `existing-${index}`, url }))}
                      onReorder={(reordered) => setExistingGallery(reordered.map((img) => img.url))}
                      onRemove={(id) => removeExistingGalleryImage(parseInt(id.split('-')[1], 10))}
                      label="Befintliga bilder:"
                      itemLabel="Befintlig"
                      className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4"
                    />
                  )}
                  {/* Promote a gallery image to Huvudbild. Studio mockups arrive
                      in this gallery, so without this the only way to change the
                      main image was re-uploading a file by hand. Existing
                      (uploaded) images only — new picks have no URL yet. */}
                  {existingGallery.length > 0 && (
                    <div className="mb-4">
                      <span className={labelCls}>Välj huvudbild ur galleriet</span>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {existingGallery.map((url) => {
                          const isMain = url === formData.b2cImageUrl && !mainImageFile;
                          return (
                            <button
                              key={url}
                              type="button"
                              onClick={() => useAsMainImage(url)}
                              aria-pressed={isMain}
                              title={isMain ? 'Detta är huvudbilden' : 'Använd som huvudbild'}
                              className={`w-20 rounded-[var(--radius-admin-el)] border p-1 transition ${
                                isMain
                                  ? 'border-admin-info-dot ring-1 ring-admin-info-dot/40'
                                  : 'border-admin-border hover:bg-admin-surface-2'
                              }`}
                            >
                              <img src={url} alt="" loading="lazy" decoding="async" className="aspect-square w-full rounded-[4px] bg-white object-contain" />
                              <span className="mt-0.5 block truncate text-center text-[10px] text-admin-text-muted">
                                {isMain ? 'Huvudbild' : 'Använd'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {galleryPreviews.length > 0 && (
                    <SortableImageGallery
                      images={galleryPreviews.map((preview, index) => ({ id: `new-${index}`, url: preview, file: galleryFiles[index] }))}
                      onReorder={(reordered) => {
                        setGalleryPreviews(reordered.map((img) => img.url));
                        setGalleryFiles(reordered.map((img) => img.file));
                      }}
                      onRemove={(id) => removeNewGalleryImage(parseInt(id.split('-')[1], 10))}
                      label="Nya bilder att ladda upp:"
                      itemLabel="Ny"
                      className="grid grid-cols-2 gap-4 md:grid-cols-4"
                    />
                  )}
                </div>
              </div>
            </CardSection>

            {/* Variants — the rail (v2.2): left = vertical list of the
                product's variants (thumbnail + name, selected highlighted),
                right = full editor for the selected variant (name, image,
                SKU, price, sizes). No toggle: an empty list IS the off state. */}
            <CardSection title="Varianter" bodyClassName="space-y-4">
              {formData.variantGroups.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-[13px] text-admin-text-muted">
                    Den här produkten har inga varianter. Lägg till varianter om produkten
                    finns i flera utföranden — t.ex. färger eller vikter — med egen bild,
                    eget pris och egna storlekar. Produkten som den ser ut nu blir automatiskt
                    första varianten (”Original” — byt gärna namn).
                  </p>
                  <Button type="button" variant="secondary" onClick={addGroup}>+ Lägg till variant</Button>
                </div>
              ) : (
                <div className="flex flex-col gap-4 sm:flex-row">
                  {/* Rail — drag the grip to reorder; order = storefront order */}
                  <div className="flex shrink-0 flex-row gap-2 overflow-x-auto sm:w-44 sm:flex-col sm:overflow-visible">
                    <DndContext sensors={railSensors} collisionDetection={closestCenter} onDragEnd={onRailDragEnd}>
                      <SortableContext items={formData.variantGroups.map((_, i) => String(i))} strategy={rectSortingStrategy}>
                        {formData.variantGroups.map((g, idx) => (
                          <SortableRailItem
                            key={idx}
                            id={String(idx)}
                            selected={idx === selectedGroupIdx}
                            thumb={g.images[0]?.preview || g.images[0]?.url || formData.b2cImageUrl || ''}
                            title={g.label.trim() || `Variant ${idx + 1}`}
                            subtitle={g.sizes.length > 0 ? g.sizes.join(' · ') : ''}
                            onSelect={() => { setSelectedGroupIdx(idx); setSizeInput(''); }}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                    <Button type="button" variant="secondary" onClick={addGroup} className="shrink-0 sm:w-full">+ Lägg till variant</Button>
                  </div>

                  {/* Editor for the selected variant */}
                  {formData.variantGroups[selectedGroupIdx] && (() => {
                    const idx = selectedGroupIdx;
                    const g = formData.variantGroups[idx];
                    const galleryChoices = [formData.b2cImageUrl, ...existingGallery].filter(Boolean);
                    const autoSku = `${formData.sku || skuFromName(formData.name)}-${skuFromName(g.label || `variant-${idx + 1}`)}`;
                    return (
                      <div className="min-w-0 flex-1 space-y-4 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 p-4">
                        <div>
                          <label className={labelCls}>Namn</label>
                          <input
                            value={g.label}
                            onChange={(e) => updateGroup(idx, { label: e.target.value })}
                            placeholder="t.ex. Svart, Vit eller 500g"
                            className={inputCls}
                          />
                        </div>

                        <div>
                          <label className={labelCls}>Bilder</label>
                          <div className="space-y-2">
                            {g.images.length > 0 && (
                              /* Same sortable gallery as the product media —
                                 drag to reorder; position 0 is the huvudbild. */
                              <SortableImageGallery
                                images={g.images.map((im, imgIdx) => ({ id: String(imgIdx), url: im.preview || im.url }))}
                                onReorder={(reordered) => updateGroup(idx, { images: reordered.map((it) => g.images[Number(it.id)]) })}
                                onRemove={(id) => removeGroupImage(idx, Number(id))}
                                label="Dra för att ändra ordning — första bilden är huvudbilden:"
                                itemLabel=""
                                className="grid grid-cols-3 gap-3 md:grid-cols-4"
                              />
                            )}
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              onChange={(e) => {
                                addGroupImageFiles(idx, Array.from(e.target.files || []));
                                e.target.value = '';
                              }}
                              className="block w-full text-[13px] text-admin-text-muted file:mr-4 file:rounded-[var(--radius-admin-el)] file:border-0 file:bg-admin-surface file:px-4 file:py-2 file:text-[13px] file:font-medium file:text-admin-text"
                            />
                            {galleryChoices.filter((url) => !g.images.some((im) => im.url === url)).length > 0 && (
                              <div>
                                <p className="mb-1 text-[12px] text-admin-text-muted">Eller välj från produktens bilder:</p>
                                <div className="flex flex-wrap gap-2">
                                  {galleryChoices.filter((url) => !g.images.some((im) => im.url === url)).map((url) => (
                                    <button
                                      key={url}
                                      type="button"
                                      onClick={() => addGroupImageUrl(idx, url)}
                                      className="h-12 w-12 overflow-hidden rounded-[var(--radius-admin-el)] border-2 border-admin-border bg-white hover:border-[var(--color-admin-primary)]"
                                      title="Lägg till på varianten"
                                    >
                                      <img src={url} alt="" className="h-full w-full object-cover" />
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          <p className={helpCls}>
                            Flera bilder per variant. Den första är huvudbilden — den visas i butiken när kunden
                            väljer varianten; övriga läggs till i produktens bildgalleri.
                          </p>
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div>
                            <label className={labelCls}>SKU (Artikelnummer)</label>
                            <input
                              value={g.sku}
                              onChange={(e) => updateGroup(idx, { sku: e.target.value })}
                              placeholder={autoSku}
                              className={inputCls}
                            />
                            <p className={helpCls}>Tomt = skapas automatiskt.</p>
                          </div>
                          <div>
                            <label className={labelCls}>Pris (SEK, inkl. moms)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={g.price}
                              onChange={(e) => updateGroup(idx, { price: e.target.value })}
                              placeholder={String(formData.price || 0)}
                              className={inputCls}
                            />
                            <p className={helpCls}>Tomt = produktens pris. Gäller alla storlekar.</p>
                          </div>
                        </div>

                        <div>
                          <label className={labelCls}>Storlekar (valfritt)</label>
                          <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1.5">
                            {g.sizes.map((size) => (
                              <span key={size} className="inline-flex items-center gap-1 rounded-[var(--radius-admin-el)] bg-admin-info-bg px-2 py-0.5 text-[12px] font-medium text-admin-info-text">
                                {size}
                                <button type="button" onClick={() => removeSize(idx, size)} className="text-admin-info-text hover:opacity-70" aria-label={`Ta bort ${size}`}>×</button>
                              </span>
                            ))}
                            <input
                              value={sizeInput}
                              onChange={(e) => setSizeInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSizes(idx); }
                                else if (e.key === 'Backspace' && !sizeInput && g.sizes.length) {
                                  removeSize(idx, g.sizes[g.sizes.length - 1]);
                                }
                              }}
                              onBlur={() => addSizes(idx)}
                              placeholder={g.sizes.length ? '' : 't.ex. XS, S, M, L, XL'}
                              className="min-w-[8rem] flex-1 bg-transparent text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none"
                            />
                          </div>
                          <p className={helpCls}>
                            Enter eller komma för att lägga till. Kunden väljer storlek i butiken och varje
                            storlek får eget artikelnummer automatiskt. Lämna tomt om varianten saknar storlekar.
                            Olika pris per utförande? Skapa en egen variant i stället för en storlek.
                            Obs: frakten beräknas alltid på produktens vikt — varianter har ingen egen vikt.
                          </p>
                        </div>

                        <div className="flex justify-end border-t border-admin-border-soft pt-3">
                          <Button type="button" variant="plain" onClick={() => removeGroup(idx)} className="text-admin-critical-dot">
                            Ta bort variant
                          </Button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardSection>

            {/* Category — Shopify places this in the main column under Media.
                Same autocomplete + state as before (moved out of the rail). */}
            <CardSection title="Kategori" bodyClassName="space-y-2">
              <div className="relative">
                <input
                  value={categoryInput}
                  onChange={onCategoryChange}
                  onFocus={() => {
                    if (availableCategories.length && !categoryInput.trim()) {
                      setFilteredCategories(availableCategories);
                      setShowCategorySuggestions(true);
                    }
                  }}
                  onBlur={() => setTimeout(() => setShowCategorySuggestions(false), 200)}
                  placeholder="Välj en produktkategori"
                  className={inputCls}
                />
                {showCategorySuggestions && filteredCategories.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface shadow-[var(--shadow-admin)]">
                    {filteredCategories.map((g) => (
                      <li key={g}>
                        <button type="button" onMouseDown={() => pickCategory(g)} className="block w-full px-3 py-2 text-left text-[13px] text-admin-text hover:bg-admin-surface-2">
                          {g}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={helpCls}>Driver toppmenyn + /kategori-sidor.</p>
              </div>
            </CardSection>

            {/* Price */}
            <CardSection title="Pris" bodyClassName="space-y-3">
              <div className="max-w-xs">
                <label className={labelCls}>Pris (SEK, inkl. moms)</label>
                <input type="number" name="price" min="0" step="0.01" value={formData.price} onChange={handleInput} className={inputCls} />
                {podFloor != null && (
                  <>
                    {/* Inköpspriset FÖRST och som ETT tal — säljaren vill veta vad
                        plagget kostar honom, inte se en uträkning. Golvraden under
                        upprepar därför inte längre kostnadsposterna. */}
                    <p className="mt-2 text-[13px] text-admin-text-muted">
                      Inköp: <span className="font-medium text-admin-text">{product.podCostSek} kr</span>
                    </p>
                    <p className={`mt-1 text-[12px] ${parseFloat(formData.price) < podFloor ? 'text-admin-critical-text' : 'text-admin-text-muted'}`}>
                      Prisgolv: <span className="font-medium">{podFloor} kr</span> — vid det priset tjänar du 0 kr
                      (avgift {Math.round(FEE_RATE * 100)} % + {FEE_FIXED} kr inräknad).
                    </p>
                    {(() => {
                      const pNow = parseFloat(formData.price);
                      const profitNow = sellerProfitExVat(pNow, product.podCostSek);
                      const marginNow = sellerMargin(pNow, product.podCostSek);
                      return profitNow != null && pNow >= podFloor ? (
                        <p className="mt-0.5 text-[12px] text-admin-text-muted">
                          Vid {pNow} kr tjänar du ca <span className="font-medium text-admin-text">{Math.round(profitNow)} kr</span> per försäljning
                          {marginNow != null && ` (${Math.round(marginNow * 100)} % marginal, exkl. moms)`}.
                        </p>
                      ) : null;
                    })()}
                    {/* Marginal → pris, samma verktyg som i Designstudion: skriv
                        målmarginalen, få ett …9-pris som faktiskt GER den marginalen
                        (priceForMargin är avgiftsmedveten), aldrig under golvet. */}
                    {(() => {
                      const m = parseFloat(podMarginTarget);
                      const raw = Number.isFinite(m) ? priceForMargin(product.podCostSek, m / 100) : null;
                      const suggested = raw == null ? null : Math.max(roundUpTo9(raw), podFloor);
                      // flex-wrap: fältet ligger i en max-w-xs-kolumn, så
                      // förhandsvisning + knapp lägger sig på egen rad när det knappar.
                      return (
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                          <span className="text-[12px] text-admin-text-muted">Önskad marginal</span>
                          <input
                            type="number"
                            min="0"
                            max="85"
                            step="1"
                            value={podMarginTarget}
                            aria-label="Önskad marginal i procent"
                            onChange={(e) => setPodMarginTarget(e.target.value)}
                            className="w-16 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                          />
                          <span className="text-[12px] text-admin-text-muted">%</span>
                          <span className="text-[12px] text-admin-text-muted">
                            Rekommenderat pris: <span className="font-medium text-admin-text">{suggested == null ? '—' : `${suggested} kr`}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => suggested != null && setField('price', String(suggested))}
                            disabled={suggested == null}
                            className="rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1 text-[12px] text-admin-text hover:bg-admin-surface-2 disabled:cursor-default disabled:opacity-40"
                          >
                            Använd priset
                          </button>
                        </div>
                      );
                    })()}
                  </>
                )}
                {podEnabled && formData.isPodProduct && podFloor == null && (
                  <p className="mt-1 text-[12px] text-admin-text-muted">
                    Prisgolv och vinstkalkyl aktiveras när produkten publiceras (om) via Designstudion — det är där produkttypens produktionskostnad blir känd.
                  </p>
                )}
              </div>
              <div className="max-w-xs">
                <label className={labelCls}>Ordinarie pris / REA (valfritt)</label>
                <input type="number" name="compareAtPrice" min="0" step="0.01" value={formData.compareAtPrice} onChange={handleInput} placeholder="Tomt = ingen rea" className={inputCls} />
                <p className={helpCls}>
                  Sätt ett högre ordinarie pris för att visa REA (överstruket). Enligt prisinformationslagen
                  måste ordinarie pris vara det lägsta priset de senaste 30 dagarna.
                </p>
              </div>
              {/* Wholesale price — only when the shop has the B2B add-on. The
                  consumer storefront never reads this; the B2B portal charges it. */}
              {b2bEnabled && (
                <div className="max-w-xs">
                  <label className={labelCls}>Grossistpris (SEK, ex. moms)</label>
                  <input type="number" name="b2bPrice" min="0" step="0.01" value={formData.b2bPrice} onChange={handleInput} className={inputCls} />
                  <p className={helpCls}>Priset B2B-återförsäljare betalar. Visas inte i konsumentbutiken.</p>
                </div>
              )}
              <div>
                <label className={labelCls}>Lanseringsdatum (valfritt)</label>
                <input type="datetime-local" name="launchDate" value={formData.launchDate} onChange={handleInput} className={inputCls + ' max-w-xs'} />
              </div>
            </CardSection>

            {/* Inventory — POD: stock is not tracked. Mirrors Shopify's
                "Inventory not tracked" card visually; no field is persisted. */}
            <CardSection title="Lager" bodyClassName="space-y-1">
              <p className="text-[13px] text-admin-text-muted">Lager spåras inte</p>
              <p className={helpCls}>Försäljningen är obegränsad (print-on-demand) — inget lagersaldo dras.</p>
            </CardSection>

            {/* Shipping + Weight — Shopify orders Shipping before Variants */}
            <CardSection title="Frakt" bodyClassName="space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[
                  ['sweden', 'Sverige'],
                  ['nordic', 'Norden'],
                  ['eu', 'EU'],
                  ['worldwide', 'Världen'],
                ].map(([key, label]) => (
                  <div key={key}>
                    <label className={labelCls}>{label} (SEK)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.shipping[key].cost}
                      onChange={(e) =>
                        setField('shipping', {
                          ...formData.shipping,
                          [key]: { ...formData.shipping[key], cost: parseFloat(e.target.value) || 0 },
                        })
                      }
                      className={inputCls}
                    />
                  </div>
                ))}
              </div>
              <div className="max-w-xs">
                <label className={labelCls}>Vikt</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.weight.value}
                    onChange={(e) => setField('weight', { ...formData.weight, value: parseFloat(e.target.value) || 0 })}
                    className={inputCls}
                  />
                  <select
                    value={formData.weight.unit}
                    onChange={(e) => setField('weight', { ...formData.weight, unit: e.target.value })}
                    className={inputCls + ' max-w-[6rem]'}
                  >
                    <option value="g">g</option>
                    <option value="kg">kg</option>
                  </select>
                </div>
              </div>
              <p className={helpCls}>Vikt påverkar frakten i kassan; viktbaserade nivåer beräknas automatiskt.</p>

              {/* Per-product delivery modes (Delivery & Pickup v2). Controls
                  whether this product can be shipped and/or picked up. The
                  storefront + checkout offer only the enabled methods, and the
                  server rejects a charge using a disabled method. Both default
                  on; at least one must stay on. */}
              <div className="border-t border-admin-border-soft pt-4">
                <label className={labelCls}>Leveranssätt</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[13px] text-admin-text">
                    <input
                      type="checkbox"
                      checked={formData.delivery.shipping}
                      onChange={(e) => setField('delivery', { ...formData.delivery, shipping: e.target.checked })}
                      className={checkboxCls}
                    />
                    Kan skickas (hemleverans)
                  </label>
                  <label className="flex items-center gap-2 text-[13px] text-admin-text">
                    <input
                      type="checkbox"
                      checked={formData.delivery.pickup}
                      onChange={(e) => setField('delivery', { ...formData.delivery, pickup: e.target.checked })}
                      className={checkboxCls}
                    />
                    Kan hämtas (upphämtning / Click &amp; Collect)
                  </label>
                </div>
                <p className={helpCls}>Minst ett alternativ måste vara valt. Styr vilka leveranssätt kunden kan välja i kassan.</p>
              </div>
            </CardSection>

            {/* Save bar */}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>Avbryt</Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? 'Sparar…' : product ? 'Spara ändringar' : 'Skapa produkt'}
              </Button>
            </div>
          </>
        }
        rail={
          <>
            {/* Status */}
            <CardSection title="Status" bodyClassName="space-y-3">
              <label className="flex items-center gap-2 text-[13px] text-admin-text">
                <input id="isActive" type="checkbox" name="isActive" checked={formData.isActive} onChange={handleInput} className={checkboxCls} />
                Aktiv (synlig i butiken)
              </label>
              <label className="flex items-center gap-2 text-[13px] text-admin-text">
                <input id="featured" type="checkbox" checked={formData.featured} onChange={(e) => setField('featured', e.target.checked)} className={checkboxCls} />
                Utvald på startsidan
              </label>
              <p className={helpCls}>Visas i Utvalt-sektionen högst upp på butikens startsida. Kan även slås på med stjärnan i produktlistan.</p>
            </CardSection>

            {/* Publishing — per-channel availability gates. MERGE into the
                availability object (never replace it) so the b2c toggle can't
                clobber the sibling b2b key, and vice versa. */}
            <CardSection title="Publicering" bodyClassName="space-y-3">
              {podEnabled && (
                <>
                  <label className="flex items-center gap-2 text-[13px] text-admin-text">
                    <input
                      id="isPodProduct"
                      type="checkbox"
                      checked={formData.isPodProduct}
                      onChange={(e) => {
                        const next = e.target.checked;
                        // Guard the check→uncheck transition on a product that HAS a
                        // live print connection: unchecking demotes it to a regular
                        // product and the tryckkoppling goes inert (no mapping
                        // cleanup happens here). Warn before applying; cancel keeps
                        // the checkbox checked. Every other toggle is untouched.
                        // While mappings are still loading (podMappingSkus null) an
                        // EXISTING product's connection state is unknown — fail SAFE
                        // and warn anyway rather than silently skipping the guard.
                        if (formData.isPodProduct && !next && (podConnected || (product && podMappingSkus === null))) {
                          const ok = window.confirm(
                            'Produkten har en tryckkoppling. Om du tar bort POD-markeringen slutar kopplingen att gälla och produkten behandlas som en vanlig produkt. Fortsätta?'
                          );
                          if (!ok) return;
                        }
                        setField('isPodProduct', next);
                      }}
                      className={checkboxCls}
                    />
                    Print on demand-produkt
                  </label>
                  <p className={helpCls}>
                    Trycks per beställning. Kräver en tryckkoppling (motiv + placering) innan produkten kan visas i webbshoppen.
                  </p>
                </>
              )}
              {/* THE LIVE-GATE: an unconnected POD product can be saved but never
                  shown — orders for it would silently never reach the printer.
                  The block says WHY and offers both fixes. */}
              {podGateActive && (
                <div className="rounded-[var(--radius-admin-el)] bg-admin-caution-bg px-3 py-2.5">
                  <p className="text-[13px] font-semibold text-admin-caution-text">
                    Produkten kan inte visas i webbshoppen än — tryckkoppling saknas.
                  </p>
                  <p className="mt-1 text-[12px] text-admin-caution-text">
                    Utan koppling vet tryckeriet inte vilket motiv och vilken placering som ska tryckas,
                    så beställningar skulle fastna. Produkten går bra att spara som utkast.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {product && (product.documentId || product.id) && (
                      <Link
                        to={`/admin/pod?designFor=${product.documentId || product.id}`}
                        className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[12px] font-medium text-admin-text hover:bg-admin-surface-2"
                      >
                        Designa i studion (kopplas automatiskt)
                      </Link>
                    )}
                    <Link
                      to="/admin/pod?tab=mapping"
                      className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[12px] font-medium text-admin-text hover:bg-admin-surface-2"
                    >
                      Koppla manuellt (Avancerat)
                    </Link>
                  </div>
                </div>
              )}
              {podEnabled && formData.isPodProduct && podConnected && (
                <p className="text-[12px] text-admin-success-text">
                  ✓ Tryckkoppling finns — produkten kan visas i webbshoppen.
                </p>
              )}
              <label className={`flex items-center gap-2 text-[13px] ${podGateActive ? 'cursor-not-allowed text-admin-text-muted' : 'text-admin-text'}`}>
                <input
                  id="avB2c"
                  type="checkbox"
                  checked={formData.availability.b2c && !podGateActive}
                  disabled={podGateActive}
                  onChange={(e) => setField('availability', { ...formData.availability, b2c: e.target.checked })}
                  className={checkboxCls}
                />
                Tillgänglig i webbshoppen
              </label>
              <p className={helpCls}>
                {podGateActive
                  ? 'Låst tills produkten har en tryckkoppling — se rutan ovan.'
                  : 'Avmarkera för att dölja produkten i webbshoppen utan att inaktivera den.'}
              </p>
              {/* B2B-availability gate — only for shops with the B2B add-on. Lets
                  an admin offer a product wholesale-only or hide it from B2B
                  while keeping it in the consumer shop (independent of b2c). */}
              {b2bEnabled && (
                <>
                  <label className="flex items-center gap-2 text-[13px] text-admin-text">
                    <input id="avB2b" type="checkbox" checked={formData.availability.b2b} onChange={(e) => setField('availability', { ...formData.availability, b2b: e.target.checked })} className={checkboxCls} />
                    Tillgänglig i grossistportalen
                  </label>
                  <p className={helpCls}>Avmarkera för att dölja produkten för B2B-kunder.</p>
                </>
              )}
            </CardSection>

            {/* Right of withdrawal / made-to-order (POD consumer law). */}
            <CardSection title="Ångerrätt" bodyClassName="space-y-3">
              <label className="flex items-center gap-2 text-[13px] text-admin-text">
                <input
                  id="isPersonalized"
                  type="checkbox"
                  checked={formData.isPersonalized}
                  onChange={(e) => setField('isPersonalized', e.target.checked)}
                  className={checkboxCls}
                />
                Specialtillverkad / personlig produkt (ingen ångerrätt)
              </label>
              <p className={helpCls}>
                Markera om produkten tillverkas efter kundens egen design, text, bild eller mått.
                Då gäller ingen 14-dagars ångerrätt — kunden måste godkänna detta i kassan innan köp.
                Lämna omarkerad för en standardprodukt med full ångerrätt.
              </p>
            </CardSection>

            {/* Organization — tags (category lives in the main column, Shopify-style) */}
            <CardSection title="Organisation" bodyClassName="space-y-4">
              <div className="relative">
                <label className={labelCls}>Taggar</label>
                <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1.5">
                  {formData.tags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 rounded-[var(--radius-admin-el)] bg-admin-info-bg px-2 py-0.5 text-[12px] font-medium text-admin-info-text">
                      {tag}
                      <button type="button" onClick={() => removeTag(tag)} className="text-admin-info-text hover:opacity-70" aria-label={`Ta bort ${tag}`}>×</button>
                    </span>
                  ))}
                  <input
                    value={tagInput}
                    onChange={(e) => { setTagInput(e.target.value); setShowTagSuggestions(true); }}
                    onFocus={() => setShowTagSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowTagSuggestions(false), 200)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
                      else if (e.key === 'Backspace' && !tagInput && formData.tags.length) {
                        removeTag(formData.tags[formData.tags.length - 1]);
                      }
                    }}
                    placeholder={formData.tags.length ? '' : 't.ex. Lax, Nyhet'}
                    className="min-w-[6rem] flex-1 bg-transparent text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none"
                  />
                </div>
                {showTagSuggestions && tagSuggestions.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface shadow-[var(--shadow-admin)]">
                    {tagSuggestions.map((tg) => (
                      <li key={tg}>
                        <button type="button" onMouseDown={() => addTag(tg)} className="block w-full px-3 py-2 text-left text-[13px] text-admin-text hover:bg-admin-surface-2">
                          {tg}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={helpCls}>
                  Enter eller komma för att lägga till. Taggar är fria etiketter för din egen
                  organisation — Utvalt på startsidan styrs av kryssrutan under Status.
                </p>
              </div>
            </CardSection>
          </>
        }
      />
    </form>
  );
};

export default ProductForm;
