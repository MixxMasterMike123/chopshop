// Advisory artwork/garment contrast checks for the Design Studio.
//
// This deliberately never blocks publishing. It samples the real transparent
// artwork preview against the configured garment colour and flags combinations
// where most visible pixels have very little tonal separation. The final mockup
// remains the source of truth; this is an early guardrail, not a print guarantee.
import { contrastRatio, hexToRgb } from '../../../utils/colorContrast.js';

const SAMPLE_EDGE = 72;
const LOW_CONTRAST_RATIO = 1.8;
const LOW_PIXEL_SHARE = 0.55;
const cache = new Map();

const channel = (value) => {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const luminance = ({ r, g, b }) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export const classifyHexTone = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'unknown';
  return luminance(rgb) >= 0.42 ? 'light' : 'dark';
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Could not sample artwork preview.'));
  img.src = src;
});

export const analyzeArtworkContrast = async (previewUrl, garmentHex) => {
  const garment = hexToRgb(garmentHex);
  if (!previewUrl || !garment || typeof document === 'undefined') return null;

  const key = `${previewUrl}|${garmentHex}`;
  if (cache.has(key)) return cache.get(key);

  const pending = (async () => {
    try {
      const img = await loadImage(previewUrl);
      const scale = Math.min(SAMPLE_EDGE / img.naturalWidth, SAMPLE_EDGE / img.naturalHeight, 1);
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;

      let visible = 0;
      let lowContrast = 0;
      let weightedLum = 0;
      let alphaWeight = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255;
        if (alpha < 0.12) continue;
        const printed = {
          r: Math.round(pixels[i] * alpha + garment.r * (1 - alpha)),
          g: Math.round(pixels[i + 1] * alpha + garment.g * (1 - alpha)),
          b: Math.round(pixels[i + 2] * alpha + garment.b * (1 - alpha)),
        };
        visible += 1;
        if (contrastRatio(printed, garment) < LOW_CONTRAST_RATIO) lowContrast += 1;
        weightedLum += luminance({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] }) * alpha;
        alphaWeight += alpha;
      }

      if (!visible || !alphaWeight) return null;
      const lowContrastShare = lowContrast / visible;
      const artworkLum = weightedLum / alphaWeight;
      const artworkTone = artworkLum >= 0.55 ? 'light' : artworkLum <= 0.2 ? 'dark' : 'mixed';
      const garmentTone = classifyHexTone(garmentHex);
      return {
        warning: lowContrastShare >= LOW_PIXEL_SHARE,
        lowContrastShare,
        artworkTone,
        garmentTone,
      };
    } catch {
      // A missing preview or an unexpected CORS policy must not interrupt the
      // Studio. The seller can still review the truthful live composite.
      return null;
    }
  })();

  cache.set(key, pending);
  return pending;
};
