// ProductMapping's data layer for the ADMIN build (CP5 unit FM): the alias
// list of vite.admin.config.js puts this module in place of
// src/wagons/pod-wagon/components/productMappingData.js (the older build's,
// Firestore). Same names.
//
// On the Worker a mapping is "product P (or its variant V) prints artwork A on
// slots S of printer X's article K" (cloudflare/src/pod/pod-mappings.ts):
// the printer and its ARTICLE (the physical blank, e.g. a tee in one colour
// and size) replace the older garment + one placement, and one mapping may
// print the same artwork on several slots. So the form picks a printer, an
// article and the slots (usePrinterChoice), and shows the server's ONE
// number for that choice before it is saved (GET …/pod/design-quote): Inköp
// and the price floor, nothing else. The save is POST …/pod/mappings; the
// server checks the artwork, the article, the frames, the resolution and —
// for a published product — the price floor, and its refusal is said at the
// form. A removal is DELETE …/pod/mappings/:id (the row stays inactive; a
// published product that loses its last mapping leaves the storefront by
// the server's own rule, so nothing is unpublished from the browser).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMapping, deleteMapping, getDesignQuote } from '../../api/admin/pod.js';
import { readForShop } from '../providers/ordersForShop.js';
import { slotLabel } from '../../config/podSlots.js';
import { garmentLabel } from '../../config/podGarments.js';
import {
  articleText,
  mappingRefusalMessage,
  quoteRefusalMessage,
  quoteText,
  scopeSlots,
  slotsText,
} from '../adapters/pod.js';
import { loadPrinterChoices } from './podLibraryLoad.js';

export const PRINTER_ROUTED = true;

export const MAPPING_INTRO =
  'Koppla en print on demand-produkt till tryckeriet: välj produkten, ett godkänt original, tryckeriets artikel (plagget, i färg och storlek) och var på plagget motivet trycks. ' +
  'Har produkten storlekar eller färger som är egna artiklar hos tryckeriet, koppla varje variant till sin artikel. Produkten säljs i webbshoppen först när den är kopplad.';

/** Only an artwork the server approved can be printed. */
export const selectableForMapping = (art) => art?.status === 'ready';

function pageError(message, cause) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return error;
}

/**
 * A picked or typed SKU → { productId, variantId, priceMinor } from the
 * picker's products (exact match: the product's own SKU maps the whole
 * product, a variant's only that variant), or null.
 */
export function targetOf(products, sku) {
  const key = String(sku ?? '').trim();
  if (!key) return null;
  for (const p of products ?? []) {
    if (p.hasSku && p.sku === key) return { productId: p.id, variantId: null, priceMinor: p.priceMinor ?? null };
    const v = (p.variants ?? []).find((x) => x.sku === key);
    if (v?.variantId) return { productId: p.id, variantId: v.variantId, priceMinor: v.priceMinor ?? p.priceMinor ?? null };
  }
  return null;
}

/** The list rows → the mapping shape scopeSlots reads. */
const asMappings = (rows) =>
  (rows ?? []).map((m) => ({
    status: m.status,
    productId: m.productId,
    variantId: m.variantId ?? null,
    printerId: m.printerId,
    sku: m.printerSku,
    slots: (m.slotIds ?? []).map((slot) => ({ slot })),
  }));

const krOf = (minor) => `${(minor / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;

/**
 * The printer, article and slots of the form, and the server's quote for
 * them. Printers are read once per shop (the library reads them too).
 */
export function usePrinterChoice({ shopId, sku, products, mappings }) {
  const [printers, setPrinters] = useState([]);
  const [printersLoading, setPrintersLoading] = useState(true);
  const [printersFailed, setPrintersFailed] = useState(false);
  const [printerId, setPrinterIdState] = useState('');
  const [articleSku, setArticleSkuState] = useState('');
  const [slots, setSlots] = useState(() => new Set());
  const [quote, setQuote] = useState({ state: 'idle' });
  const quoteSeq = useRef(0);

  useEffect(() => {
    let live = true;
    setPrintersLoading(true);
    loadPrinterChoices(shopId)
      .then((list) => {
        if (!live) return;
        setPrinters(list);
        setPrintersFailed(false);
        // One printer: it is the choice (the platform's default is not the seller's to read).
        if (list.length === 1) setPrinterIdState((current) => current || list[0].printerId);
      })
      .catch(() => {
        if (live) setPrintersFailed(true);
      })
      .finally(() => {
        if (live) setPrintersLoading(false);
      });
    return () => {
      live = false;
    };
  }, [shopId]);

  const printer = printers.find((p) => p.printerId === printerId) ?? null;
  const articles = useMemo(
    () => (printer?.articles ?? []).map((a) => ({ ...a, text: `${articleText(a, garmentLabel)}${a.provisional ? ' · preliminära mått' : ''}` })),
    [printer],
  );
  const article = articles.find((a) => a.sku === articleSku) ?? null;
  const chosenSlots = (article?.slots ?? []).filter((s) => slots.has(s));
  const slotKey = chosenSlots.join(',');
  const target = targetOf(products, sku);
  const targetKey = target ? `${target.productId}\n${target.variantId ?? ''}` : '';

  const setPrinterId = useCallback((id) => {
    setPrinterIdState(id);
    setArticleSkuState('');
    setSlots(new Set());
  }, []);

  const setArticleSku = useCallback((nextSku) => {
    setArticleSkuState(nextSku);
    const next = (printer?.articles ?? []).find((a) => a.sku === nextSku);
    setSlots((prev) => {
      const kept = new Set([...prev].filter((s) => next?.slots.includes(s)));
      if (kept.size === 0 && next?.slots.includes('front')) kept.add('front');
      return kept;
    });
  }, [printer]);

  const toggleSlot = useCallback((slot) => {
    setSlots((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot); else next.add(slot);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setArticleSkuState('');
    setSlots(new Set());
  }, []);

  // The quote of the garment this choice makes: the chosen slots, plus those
  // the product's (or variant's) other mappings on the same article print.
  const quoteSlots = target && printerId && articleSku
    ? scopeSlots(asMappings(mappings), { productId: target.productId, variantId: target.variantId, printerId, sku: articleSku, slots: chosenSlots })
    : chosenSlots;
  const quoteKey = printerId && articleSku && chosenSlots.length > 0 ? `${printerId}\n${articleSku}\n${quoteSlots.join(',')}` : '';

  useEffect(() => {
    const seq = ++quoteSeq.current;
    if (!quoteKey) {
      setQuote({ state: 'idle' });
      return undefined;
    }
    const [pid, art, slotList] = quoteKey.split('\n');
    setQuote({ state: 'loading' });
    const timer = setTimeout(() => {
      readForShop(shopId, (id) => getDesignQuote({ printerId: pid, sku: art, slots: slotList.split(',') }, { shopId: id }))
        .then((answer) => {
          if (seq === quoteSeq.current) setQuote({ state: 'ok', quote: answer, slots: slotList.split(',') });
        })
        .catch((error) => {
          if (seq === quoteSeq.current) setQuote({ state: 'refused', message: quoteRefusalMessage(error) });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [quoteKey, shopId]);

  let note = null;
  if (printersFailed) note = { tone: 'caution', text: 'Tryckerierna kunde inte hämtas. Ladda om sidan.' };
  else if (!printersLoading && printers.length === 0) note = { tone: 'caution', text: 'Inga tryckerier är tillgängliga för butiken ännu. Kontakta plattformen.' };
  else if (quote.state === 'idle') note = { tone: 'muted', text: 'Välj tryckeri, artikel och placering så visas inköpspris och prisgolv.' };
  else if (quote.state === 'loading') note = { tone: 'muted', text: 'Hämtar inköpspris…' };
  else if (quote.state === 'refused') note = { tone: 'caution', text: quote.message };
  else if (quote.state === 'ok') {
    const figures = quoteText(quote.quote);
    const whole = quote.slots.join(',') !== slotKey ? ` (hela plagget: ${slotsText(quote.slots, slotLabel)})` : '';
    const price = target?.priceMinor;
    const under = Number.isSafeInteger(price) && Number.isSafeInteger(quote.quote?.priceFloorMinor) && price < quote.quote.priceFloorMinor;
    note = figures
      ? {
          tone: under ? 'caution' : 'muted',
          text: `${figures}${whole}${under ? ` — produktens pris ${krOf(price)} ligger under prisgolvet: höj priset innan du kopplar en publicerad produkt.` : ''}`,
        }
      : { tone: 'caution', text: 'Inköpspriset kunde inte hämtas just nu.' };
  }

  return {
    printers,
    printersLoading,
    printerId,
    setPrinterId,
    articles,
    articleSku,
    setArticleSku,
    slotOptions: (article?.slots ?? []).map((id) => ({ id, label: slotLabel(id), checked: slots.has(id) })),
    chosenSlots,
    toggleSlot,
    reset,
    note,
  };
}

/** → { message } for the success toast. Rejects with the seller's sentence. */
export async function addMapping({ shopId, sku, artworkId, choice, products }) {
  const target = targetOf(products, sku);
  if (!target) throw pageError(`Ingen produkt eller variant i butiken har SKU:n ”${String(sku).trim()}”.`);
  if (!choice?.printerId) throw pageError('Välj tryckeri.');
  if (!choice.articleSku) throw pageError('Välj artikel.');
  if (!choice.chosenSlots?.length) throw pageError('Välj minst en placering.');
  try {
    const { created, quote } = await createMapping(
      {
        productId: target.productId,
        variantId: target.variantId,
        artworkId,
        printerId: choice.printerId,
        sku: choice.articleSku,
        slots: choice.chosenSlots,
      },
      { shopId },
    );
    const figures = quoteText(quote);
    return { message: `${created ? 'Koppling sparad' : 'Kopplingen uppdaterad'}${figures ? ` · ${figures}` : ''}` };
  } catch (error) {
    throw pageError(mappingRefusalMessage(error) ?? 'Kunde inte spara kopplingen.', error);
  }
}

export async function removeMapping({ m, shopId }) {
  try {
    await deleteMapping(m.mappingId ?? m.id, { shopId });
  } catch (error) {
    throw pageError(mappingRefusalMessage(error, { removing: true }) ?? 'Kunde inte ta bort kopplingen.', error);
  }
}
