import React from 'react';
import { Link } from 'react-router-dom';
import SmartPrice from './SmartPrice';
import { useStoreSettings } from '../../contexts/StoreSettingsContext';

/**
 * NordProductCard — the storefront product card.
 *
 * The card's DESIGN is template-driven via the `cardStyle` token (see
 * nordTokens.js). This is what makes two templates genuinely differ — not just
 * color/font but the card's shape and structure:
 *   - 'elevated' (NORD default): surface module, soft shadow, hover lift.
 *   - 'flat':     hairline border, no shadow; clean/editorial.
 *   - 'bordered': strong 2px border, no shadow; blocky/athletic.
 *   - 'overlay':  name/price overlaid on the image; image-forward/magazine.
 * Colors come from tokens (surface/ink/accent/line) so dark templates work.
 */

// Unique variant groups (by `group`, falling back to `label`), each with its
// first available image. Used for the subtle swatch hint under the price.
const variantGroups = (variants) => {
  if (!Array.isArray(variants)) return [];
  const seen = new Map();
  for (const v of variants) {
    const key = (v?.group || v?.label || '').trim();
    if (!key || seen.has(key)) continue;
    const image = v?.image || (Array.isArray(v?.images) ? v.images[0] : '') || '';
    seen.set(key, { key, image });
  }
  return Array.from(seen.values());
};

// Per-cardStyle presentation. `container` is the card box; `image` is the
// image-wrapper aspect + bg; `pad` the body padding. Kept as class strings so
// Tailwind sees them statically (no dynamic class construction).
const CARD_STYLES = {
  elevated: {
    container:
      'bg-surface rounded-tile shadow-tile overflow-hidden transition-[transform,box-shadow] duration-300 ease-nord group-hover:-translate-y-1 group-hover:shadow-lift',
    image: 'aspect-square',
    pad: 'p-5',
    overlay: false,
  },
  flat: {
    container:
      'bg-surface rounded-tile border border-line overflow-hidden transition-colors duration-300 ease-nord group-hover:border-ink/30',
    image: 'aspect-[4/5]',
    pad: 'p-4',
    overlay: false,
  },
  bordered: {
    container:
      'bg-surface rounded-el border-2 border-ink overflow-hidden transition-transform duration-200 ease-nord group-hover:-translate-y-1',
    image: 'aspect-square',
    pad: 'p-4',
    overlay: false,
  },
  overlay: {
    // Image fills the whole card; name/price/CTA sit in a scrim over it.
    container:
      'rounded-tile overflow-hidden shadow-tile transition-[transform,box-shadow] duration-300 ease-nord group-hover:-translate-y-1 group-hover:shadow-lift',
    image: 'aspect-[3/4]',
    pad: '',
    overlay: true,
  },
};

const NordProductCard = ({ to, linkState, image, imageAlt, tag, name, description, meta, priceSek, compareSek = null, isFromPrice = false, product, ctaLabel }) => {
  const store = useStoreSettings();
  const style = CARD_STYLES[store.__cardStyle] || CARD_STYLES.elevated;
  const onSale = Number(compareSek) > Number(priceSek);
  const groups = variantGroups(product?.variants);
  const showHint = groups.length >= 2;
  const thumbs = groups.filter((g) => g.image).slice(0, 4);
  const extra = groups.length - thumbs.length;

  const rating = product?.reviewCount > 0
    ? { avg: product.ratingSum > 0 ? Math.round(product.ratingSum / product.reviewCount) : 0, count: product.reviewCount }
    : null;

  const tagPill = onSale ? (
    <span className="absolute top-3.5 left-3.5 bg-accent text-accent-ink text-xs font-bold px-3 py-1.5 rounded-full">Rea!</span>
  ) : tag ? (
    <span className="absolute top-3.5 left-3.5 bg-surface/90 backdrop-blur-sm text-ink text-xs font-bold px-3 py-1.5 rounded-full">{tag}</span>
  ) : null;

  // ── OVERLAY variant: image is the card; text sits in a bottom scrim ──
  if (style.overlay) {
    return (
      <Link to={to} state={linkState} className="group block h-full">
        <div className={`relative h-full ${style.container}`}>
          <div className={`relative ${style.image} overflow-hidden`}>
            <img
              src={image}
              alt={imageAlt || name}
              className="w-full h-full object-cover transition-transform duration-700 ease-nord group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
            {tagPill}
            <div className="absolute inset-x-0 bottom-0 p-4 text-white">
              <h3 className="font-display font-bold text-lg leading-snug tracking-tight">{name}</h3>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  {isFromPrice && <span className="text-xs text-white/80 shrink-0">från</span>}
                  {onSale && (
                    <span className="text-sm text-white/70 line-through shrink-0">
                      <SmartPrice sekPrice={compareSek} showOriginal={false} />
                    </span>
                  )}
                  <SmartPrice sekPrice={priceSek} className="font-display text-white" showOriginal={false} />
                </div>
                <span className="bg-accent text-accent-ink text-sm font-bold px-4 py-2 rounded-full whitespace-nowrap transition-transform duration-300 ease-nord group-hover:-translate-y-0.5">
                  {ctaLabel}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Link>
    );
  }

  // ── Standard variants (elevated / flat / bordered): image on top, body below ──
  return (
    <Link to={to} state={linkState} className="group block h-full">
      <div className={`h-full flex flex-col ${style.container}`}>
        <div className={`relative ${style.image} overflow-hidden bg-canvas`}>
          <img
            src={image}
            alt={imageAlt || name}
            className="w-full h-full object-cover transition-transform duration-700 ease-nord group-hover:scale-105"
          />
          {tagPill}
        </div>

        <div className={`flex flex-col flex-1 ${style.pad}`}>
          <h3 className="font-display font-bold text-lg text-ink leading-snug tracking-tight">
            {name}
          </h3>
          {description && (
            <p className="text-sm text-ink-muted leading-relaxed mt-1 line-clamp-2">
              {description}
            </p>
          )}
          {meta && <p className="text-xs text-ink-faint mt-2">{meta}</p>}
          {rating && (
            <div className="flex items-center gap-1 mt-2" aria-hidden="true">
              <span className="text-sm leading-none">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} className={n <= rating.avg ? 'text-accent' : 'text-ink/20'}>★</span>
                ))}
              </span>
              <span className="text-xs text-ink-faint">({rating.count})</span>
            </div>
          )}

          <div className="mt-auto pt-4 flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-1.5 min-w-0">
              {isFromPrice && <span className="text-xs text-ink-muted shrink-0">från</span>}
              {onSale && (
                <span className="text-sm text-ink-muted line-through shrink-0">
                  <SmartPrice sekPrice={compareSek} showOriginal={false} />
                </span>
              )}
              <SmartPrice sekPrice={priceSek} className={'font-display ' + (onSale ? 'text-accent' : '')} showOriginal={false} />
            </div>
            <span className="bg-accent text-accent-ink text-sm font-bold px-5 py-2.5 rounded-full whitespace-nowrap transition-transform duration-300 ease-nord group-hover:-translate-y-0.5">
              {ctaLabel}
            </span>
          </div>

          {showHint && (
            <div className="mt-2.5 flex items-center gap-1.5">
              {thumbs.length > 0 ? (
                <>
                  <div className="flex items-center gap-1">
                    {thumbs.map((g) => (
                      <img
                        key={g.key}
                        src={g.image}
                        alt=""
                        className="h-4 w-4 rounded-full object-cover border border-ink/10"
                      />
                    ))}
                  </div>
                  {extra > 0 && <span className="text-xs text-ink-muted">+{extra}</span>}
                </>
              ) : (
                <span className="text-xs text-ink-muted">{groups.length} varianter</span>
              )}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
};

export default NordProductCard;
