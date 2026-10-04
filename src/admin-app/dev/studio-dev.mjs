// The dev API's design-studio rows (unit FN1): the platform's mockup
// templates as a shop admin reads them (GET /v1/admin/pod/mockup-templates,
// the Worker's seller shape: cloudflare/src/pod/studio-assets.ts,
// CP5_WH_REPORT.md "Seller"). The printers, the design quote, the mappings
// and the products are FM's and FC's rows (pod-dev.mjs, products-dev.mjs).
// INVENTED DATA ONLY.
//
// The templates are tied to a GARMENT. dev-printer (pod-fixtures.json) makes
// tee, hoodie and cap, so the tote bag here is listed but never offered (no
// printer makes it), and the tee's sleeve is dropped by the printer's frames.
// The photo template's "photos" are small invented PNGs made here and sent as
// data: addresses (the real ones are public-bucket URLs: see the report on
// CORS); its colourway "Sand" has no photo on purpose ("Foto saknas").
//
// The cookie `admin_dev_studio=fail` makes the template read fail (500), and
// `admin_dev_studio=empty` answers no templates.

import { deflateSync } from 'node:zlib';

export const STUDIO_COOKIE = 'admin_dev_studio';

const json = (status, body) => ({ status, body });

function cookieOf(headers, name) {
  for (const part of String(headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// ── a tiny PNG encoder (no dependency): a garment-coloured body on a backdrop ─

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A w×h PNG: a light backdrop and a rounded garment body in `hex`, as a data: address. */
export function garmentPhoto(hex, w = 300, h = 340) {
  const [r, g, b] = hexRgb(hex);
  const rows = [];
  const bx = w * 0.18, by = h * 0.14, bw = w * 0.64, bh = h * 0.76, rad = 24;
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3); // filter byte 0, then RGB
    for (let x = 0; x < w; x++) {
      const dx = Math.max(bx + rad - x, 0, x - (bx + bw - rad));
      const dy = Math.max(by + rad - y, 0, y - (by + bh - rad));
      const inside = x >= bx && x < bx + bw && y >= by && y < by + bh && dx * dx + dy * dy <= rad * rad;
      const shade = inside ? 1 - (0.08 * (y - by)) / bh : 1;
      const back = 236 - Math.round((14 * y) / h);
      row[1 + x * 3] = inside ? Math.round(r * shade) : back;
      row[2 + x * 3] = inside ? Math.round(g * shade) : back;
      row[3 + x * 3] = inside ? Math.round(b * shade) : back + 4;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ── the templates (invented; the geometry follows the seed's conventions) ───

const APPAREL = [
  { id: 'vit', label: 'Vit', hex: '#f3f3f3' },
  { id: 'svart', label: 'Svart', hex: '#26262a' },
  { id: 'sand', label: 'Sand', hex: '#d3bda5' },
];

let photos = null;
function photoUrls() {
  photos ??= { vit: garmentPhoto('#f3f3f3'), svart: garmentPhoto('#26262a') };
  return photos;
}

function templates() {
  return [
    {
      id: 'dev_tee_flat', label: 'T-shirt', garment: 'tee', profileId: 'apparel_dtg', provisional: true,
      colorways: APPAREL,
      printAreas: {
        front: { x: 280, y: 210, w: 240, h: 280 },
        back: { x: 280, y: 200, w: 240, h: 320 },
        pocket: { x: 440, y: 225, w: 80, h: 80 },
        left_sleeve: { x: 644, y: 290, w: 56, h: 56 },
      },
      printAreaMm: { front: { w: 300, h: 350 }, back: { w: 300, h: 400 }, pocket: { w: 100, h: 100 }, left_sleeve: { w: 80, h: 80 } },
      printOffsetTopMm: { front: 65, back: 85 },
      pocketPositions: { left: { x: 440 }, center: { x: 360 }, right: { x: 280 } },
    },
    {
      id: 'dev_tee_photo', label: 'T-shirt (foto)', garment: 'tee', profileId: 'apparel_dtg', provisional: false,
      colorways: APPAREL,
      printAreas: { front: { x: 105, y: 90, w: 90, h: 105 }, back: { x: 105, y: 80, w: 90, h: 120 } },
      printAreaMm: { front: { w: 300, h: 350 }, back: { w: 300, h: 400 } },
      photo: { w: 300, h: 340, urls: photoUrls(), backUrls: photoUrls() },
    },
    {
      id: 'dev_hoodie_flat', label: 'Hoodie', garment: 'hoodie', profileId: 'apparel_dtg', provisional: true,
      colorways: APPAREL.filter((c) => c.id !== 'sand'),
      printAreas: { front: { x: 280, y: 300, w: 240, h: 256 }, back: { x: 280, y: 200, w: 240, h: 320 } },
      printAreaMm: { front: { w: 300, h: 320 }, back: { w: 300, h: 400 } },
    },
    {
      id: 'dev_cap_flat', label: 'Keps', garment: 'cap', profileId: 'apparel_dtg', provisional: true,
      colorways: APPAREL.filter((c) => c.id === 'svart'),
      printAreas: { front: { x: 330, y: 330, w: 140, h: 100 } },
      printAreaMm: { front: { w: 70, h: 50 } },
      slotLabels: { front: 'Framsida' },
    },
    {
      id: 'dev_bag_flat', label: 'Tygkasse', garment: 'bag', profileId: 'apparel_dtg', provisional: true,
      colorways: APPAREL.filter((c) => c.id !== 'svart'),
      printAreas: { front: { x: 250, y: 330, w: 300, h: 300 } },
      printAreaMm: { front: { w: 250, h: 250 } },
      slotLabels: { front: 'Framsida' },
    },
  ];
}

export const STUDIO_ROUTES = [
  ['GET', '/v1/admin/pod/mockup-templates', (_state, { headers }) => {
    const scenario = cookieOf(headers, STUDIO_COOKIE);
    if (scenario === 'fail') return json(500, { error: { code: 'internal', message: 'Internal error' } });
    const list = scenario === 'empty' ? [] : templates();
    return json(200, { provisional: list.some((t) => t.provisional), templates: list });
  }],
];
