// PublishPanel's pricing and screening sources for the ADMIN build (CP5 unit
// FN1): the alias list of vite.admin.config.js puts this file where the panel
// imports src/wagons/pod-wagon/studio/publishPanelData.js (the older build's:
// podPricing.js and the client blocklist notice). Same names.
//
// THE SELLER SEES ONE NUMBER, AND IT IS THE SERVER'S. The client formula is
// not used: every name the panel imported from podPricing.js answers "no
// figure" here (null), so the profit, margin and price-from-margin tools,
// which have no server source, leave the panel (the panel hides them when
// SERVER_PRICED). Inköp and the floor come from the design quote of each
// chosen printer article (useArticleQuotes), asked after the choice settles
// (250 ms), a superseded ask aborted, each answer said as it is: pending
// while asked, refused or failed with the server's reason — never "0 kr".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { quoteRefusalMessage } from '../adapters/pod.js';
import {
  articleOptionText,
  duplicateArticles,
  floorText,
  inkopText,
  matchArticle,
  matchVariantArticle,
  quoteSummary,
} from '../adapters/studio.js';
import { quoteDesign } from './podCostQuote.js';

export const SERVER_PRICED = true;

// podPricing.js's names: no figure is computed in this build.
export const sellerProfitInkl = () => null;
export const sellerMargin = () => null;
export const priceFloor = () => null;
export const priceForMargin = () => null;
export const roundUpTo9 = () => null;
export const inklMoms = () => null;
export const FEE_RATE = null;
export const FEE_FIXED = null;

/** The notice under a successful publish: the server's screening verdict (adapters/product.js screeningNoticeFor). */
export const resultScreeningText = (result) => result?.screeningNotice ?? null;

/** The panel's texts that the Worker's model changes (null: the panel's own). */
export const PANEL_TEXT = Object.freeze({
  connectionNote:
    'Tryckkoppling ingår. Varje färg och storlek kopplas till tryckeriets artikel du väljer nedan, med motivet på de valda tryckytorna, och trycket följer med till tryckeriet vid beställning.',
  articleHelp:
    'Välj tryckeriets artikel (plagget i färg och storlek) för varje kombination som ska säljas. ”Säljs inte” utelämnar kombinationen.',
  notSold: 'Säljs inte',
  scopeTitle: 'Tryckeriets artikel per variant',
  updated: 'uppdaterades med dina mockuper och har nu designens tryckkoppling på varje variant (på artikeln du valde).',
});

export const QUOTE_DEBOUNCE_MS = 250;

/**
 * The server's quote of every chosen article, for one printer and the
 * designed slots. → { bySku: { sku → { state: 'loading' | 'ok' | 'refused'
 * | 'failed', quote?, message? } }, retry } (adapters/studio.js
 * quoteSummary reads it).
 */
export function useArticleQuotes({ shopId, printerId, skus, slots }) {
  const [entries, setEntries] = useState({}); // `${base}\n${sku}` → entry
  const [attempt, setAttempt] = useState(0);
  const failedRef = useRef(new Set());
  const base = `${shopId ?? ''}\n${printerId ?? ''}\n${(slots ?? []).join(',')}`;
  const wanted = [...new Set((skus ?? []).filter(Boolean))].sort();
  const wantedKey = wanted.join(',');

  useEffect(() => {
    if (!shopId || !printerId || !wantedKey || !(slots?.length > 0)) return undefined;
    const missing = wantedKey.split(',').filter((sku) => !entries[`${base}\n${sku}`]);
    if (missing.length === 0) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      for (const sku of missing) {
        const key = `${base}\n${sku}`;
        quoteDesign({ printerId, sku, slots }, { shopId, signal: controller.signal })
          .then((quote) => {
            if (!controller.signal.aborted) setEntries((prev) => ({ ...prev, [key]: { state: 'ok', quote } }));
          })
          .catch((error) => {
            if (controller.signal.aborted || error?.name === 'AbortError') return;
            failedRef.current.add(key);
            const refused = error?.status === 422;
            setEntries((prev) => ({
              ...prev,
              [key]: { state: refused ? 'refused' : 'failed', message: quoteRefusalMessage(error) },
            }));
          });
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `entries` is read, not followed: a settled answer must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, wantedKey, attempt]);

  const retry = useCallback(() => {
    setEntries((prev) => {
      const next = { ...prev };
      for (const key of failedRef.current) delete next[key];
      return next;
    });
    failedRef.current = new Set();
    setAttempt((n) => n + 1);
  }, []);

  const bySku = {};
  for (const sku of wanted) bySku[sku] = entries[`${base}\n${sku}`] ?? { state: 'loading' };
  return { bySku, retry };
}

/**
 * Everything the publish panel shows and checks against the SERVER's numbers
 * (SERVER_PRICED): the article chosen per colour and size (preselected where
 * exactly one article's label reads "<colour> / <size>"), the quote of each,
 * and per colour row the strictest floor and the Inköp range.
 *
 * input: { shopId, production (the studio's printer + model entry, with its
 *   articles), template, colorways (the published ones, in order), sizes
 *   (the size columns; [] = one size), slots (the designed slots), target
 *   ('new' | 'existing'), targetProduct (the picker's product, for 'existing') }
 */
export function useServerPricing({ shopId, production, template, colorways, sizes, slots, target, targetProduct }) {
  const articles = useMemo(() => production?.articles ?? [], [production]);
  const [cells, setCells] = useState({}); // `${colorwayId}\n${size}` → sku ('' = not sold)
  const [scopes, setScopes] = useState({}); // variantId ('' = the product's own) → sku
  const productionKey = production?.id ?? '';
  useEffect(() => {
    setCells({});
    setScopes({});
  }, [productionKey]);

  const cwById = useMemo(() => new Map((template?.colorways || []).map((c) => [c.id, c])), [template]);
  const columns = sizes.length > 0 ? sizes : [''];
  const articleFor = (colorwayId, size) => {
    const key = `${colorwayId}\n${size ?? ''}`;
    if (Object.hasOwn(cells, key)) return cells[key];
    return matchArticle(articles, cwById.get(colorwayId), size || null);
  };
  const setArticle = (colorwayId, size, sku) => setCells((prev) => ({ ...prev, [`${colorwayId}\n${size ?? ''}`]: sku }));

  const scopeRows = useMemo(() => {
    if (!targetProduct) return [];
    const variants = targetProduct.variants ?? [];
    return variants.length > 0
      ? variants.map((v) => ({ key: v.variantId, label: v.label }))
      : [{ key: '', label: targetProduct.name || '(namnlös produkt)' }];
  }, [targetProduct]);
  const scopeArticle = (row) => (Object.hasOwn(scopes, row.key) ? scopes[row.key] : matchVariantArticle(articles, row.label));
  const setScopeArticle = (key, sku) => setScopes((prev) => ({ ...prev, [key]: sku }));

  const newSkus = colorways.flatMap((c) => columns.map((s) => articleFor(c.id, s))).filter(Boolean);
  const scopeSkus = scopeRows.map(scopeArticle);
  const skus = target === 'existing' ? scopeSkus.filter(Boolean) : newSkus;
  const quotes = useArticleQuotes({ shopId, printerId: production?.printerId, skus, slots });

  const row = (colorwayId) => {
    const summary = quoteSummary(columns.map((s) => articleFor(colorwayId, s)), quotes.bySku);
    return { summary, inkop: inkopText(summary), floor: floorText(summary) };
  };
  const overall = quoteSummary(skus, quotes.bySku);

  let blocker = null;
  if (!production) blocker = 'Inget tryckeri kan tillverka plagget just nu. Kontakta plattformen.';
  else if (target === 'existing') {
    if (targetProduct && scopeSkus.some((sku) => !sku)) blocker = 'Välj tryckeriets artikel för varje variant.';
    else if (duplicateArticles(scopeSkus).length > 0) blocker = 'Samma artikel är vald för två varianter. Välj en egen artikel för varje variant.';
  } else if (sizes.length === 0 && colorways.some((c) => !articleFor(c.id, ''))) {
    blocker = 'Välj tryckeriets artikel för varje färg.';
  } else if (duplicateArticles(newSkus).length > 0) {
    blocker = 'Samma artikel är vald för två kombinationer. Välj en egen artikel för varje färg och storlek.';
  }
  if (!blocker && overall.state === 'pending') blocker = 'Hämtar inköpspris och prisgolv…';
  if (!blocker && overall.state === 'failed') blocker = overall.message || 'Inköpspriset kunde inte hämtas just nu.';

  return {
    articleOptions: articles.map((a) => ({ sku: a.sku, text: articleOptionText(a) })),
    articleFor,
    setArticle,
    row,
    overall,
    floor: overall.state === 'ok' ? overall.floorKr : null,
    floorText: floorText(overall),
    inkopText: inkopText(overall),
    blocker,
    retry: quotes.retry,
    scopeRows,
    scopeArticle,
    setScopeArticle,
    /** The articles the publish sends: { colorwayId → { size or '' → sku } }. */
    articlesByColorway: () => Object.fromEntries(colorways.map((c) => [c.id, Object.fromEntries(columns.map((s) => [s, articleFor(c.id, s)]))])),
    /** The articles the update sends: { variantId or '' → sku }. */
    articlesByScope: () => Object.fromEntries(scopeRows.map((r) => [r.key, scopeArticle(r)])),
  };
}
