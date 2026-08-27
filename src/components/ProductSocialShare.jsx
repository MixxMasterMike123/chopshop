import React, { useState } from 'react';
import { useTranslation } from '../contexts/TranslationContext';
import { useStoreSettings } from '../contexts/StoreSettingsContext';
import { getProductUrl } from '../utils/productUrls';

/**
 * ProductSocialShare — the storefront product page's share row.
 *
 * Share-INTENT URLs only (no SDKs, no third-party scripts, no tracking pixels).
 * `navigator.share` is offered first when the browser has it (mobile), since the
 * OS sheet beats any of our buttons; the intent buttons stay as the desktop path.
 *
 * Styling is NORD tokens only (text-ink / border-line / rounded-full), matching
 * the quantity stepper + add-to-cart controls above it, so every template gets
 * the row in its own palette. ONE product page serves all templates
 * (src/pages/shop/PublicProductPage.jsx is the single /:shopId/product/:slug
 * route) — templates are tokens, not forks, so this lands everywhere at once.
 */

const iconCls = 'h-4 w-4';

// Inline SVGs — small, neutral, currentColor (no icon dependency, no CDN).
const FacebookIcon = () => (
  <svg className={iconCls} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
  </svg>
);
const XIcon = () => (
  <svg className={iconCls} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
const PinterestIcon = () => (
  <svg className={iconCls} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.174-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.097.118.112.221.085.342-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.402.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.357-.629-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146 1.123.347 2.316.544 3.57.544 6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641.001 12.017 0z" />
  </svg>
);
const WhatsAppIcon = () => (
  <svg className={iconCls} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.465 3.488" />
  </svg>
);
const LinkIcon = () => (
  <svg className={iconCls} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);
const ShareIcon = () => (
  <svg className={iconCls} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342a3 3 0 100-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684zm0-12.632a3 3 0 105.368-2.684 3 3 0 00-5.368 2.684z" />
  </svg>
);

// Pick a localized string out of a multilingual field ({sv-SE, en-US}) or pass
// a plain string through.
const pickText = (value, lang) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const picked = value[lang] || value['sv-SE'] || value['en-US'];
    if (typeof picked === 'string') return picked;
  }
  return '';
};

const ProductSocialShare = ({ product }) => {
  const { currentLanguage } = useTranslation();
  const store = useStoreSettings();
  const [copied, setCopied] = useState(false);
  const isSwedish = currentLanguage === 'sv-SE';

  const brand = store?.shopName || '';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}${getProductUrl(product)}`;
  const title = pickText(product?.name, currentLanguage) || brand || 'Produkt';
  const text = isSwedish
    ? `Kolla in ${title}${brand ? ` från ${brand}` : ''}!`
    : `Check out ${title}${brand ? ` from ${brand}` : ''}!`;

  // Absolute image URL for Pinterest (`media` must be fetchable by Pinterest).
  const rawImage = [product?.b2cImageUrl, product?.imageUrl, product?.b2bImageUrl]
    .find((s) => typeof s === 'string' && s.trim() && !s.startsWith('data:')) || '';
  const image = rawImage && !rawImage.startsWith('http')
    ? `${origin}${rawImage.startsWith('/') ? '' : '/'}${rawImage}`
    : rawImage;

  const e = encodeURIComponent;
  const intents = [
    { key: 'facebook', name: 'Facebook', Icon: FacebookIcon, href: `https://www.facebook.com/sharer/sharer.php?u=${e(url)}` },
    { key: 'x', name: 'X', Icon: XIcon, href: `https://twitter.com/intent/tweet?url=${e(url)}&text=${e(text)}` },
    { key: 'pinterest', name: 'Pinterest', Icon: PinterestIcon, href: `https://pinterest.com/pin/create/button/?url=${e(url)}&media=${e(image)}&description=${e(text)}` },
    { key: 'whatsapp', name: 'WhatsApp', Icon: WhatsAppIcon, href: `https://wa.me/?text=${e(`${text} ${url}`)}` },
  ];

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const handleNativeShare = async () => {
    try {
      await navigator.share({ title, text, url });
    } catch {
      // User dismissed the sheet, or the browser refused — nothing to report.
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied permission) — stay silent.
    }
  };

  const btnCls =
    'inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink hover:border-ink-faint';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-faint mr-1">
        {isSwedish ? 'Dela' : 'Share'}
      </span>

      {canNativeShare && (
        <button type="button" onClick={handleNativeShare} className={btnCls}>
          <ShareIcon />
          {isSwedish ? 'Dela' : 'Share'}
        </button>
      )}

      {intents.map(({ key, name, Icon, href }) => (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={btnCls}
          aria-label={`${isSwedish ? 'Dela på' : 'Share on'} ${name}`}
          title={`${isSwedish ? 'Dela på' : 'Share on'} ${name}`}
        >
          <Icon />
        </a>
      ))}

      <button type="button" onClick={handleCopy} className={btnCls}>
        <LinkIcon />
        {copied
          ? (isSwedish ? 'Kopierad' : 'Copied')
          : (isSwedish ? 'Kopiera länk' : 'Copy link')}
      </button>
    </div>
  );
};

export default ProductSocialShare;
