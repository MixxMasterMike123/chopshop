import { describe, expect, it } from "vitest";

import type { RasterImageType, SvgRefusal } from "../src/storage/image-sniff";
import {
  checkSvg,
  normalizeImageType,
  readImageDimensions,
  sniffImageType,
  SVG_MAX_BYTES,
} from "../src/storage/image-sniff";

// ── small real files, built here ─────────────────────────────────────────────

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: readonly number[]): number {
  let low = 1;
  let high = 0;
  for (const byte of bytes) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  return ((high << 16) | low) >>> 0;
}

function pngChunk(type: string, data: readonly number[]): number[] {
  const body = [...ascii(type), ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

/**
 * A PNG with real chunk CRCs. Its IDAT is one stored deflate block holding one
 * red RGBA scanline: a valid image at 1×1, a header-true one at other sizes.
 */
function png(width = 1, height = 1): Uint8Array {
  const scanline = [0x00, 0xff, 0x00, 0x00, 0xff];
  const zlib = [
    0x78, 0x01, 0x01, ...u16le(scanline.length), ...u16le(~scanline.length & 0xffff),
    ...scanline, ...u32be(adler32(scanline)),
  ];

  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...pngChunk("IDAT", zlib),
    ...pngChunk("IEND", []),
  ]);
}

/** The classic transparent GIF, with its screen and image sizes set. */
function gif(width = 1, height = 1): Uint8Array {
  return new Uint8Array([
    ...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0x80, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, ...u16le(width), ...u16le(height), 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ]);
}

/** SOI, APP0 (JFIF), optional padding segments, SOF0, SOS, scan, EOI. */
function jpeg(width = 1, height = 1, before: readonly number[] = []): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...before,
    0xff, 0xc0, ...u16be(11), 0x08, ...u16be(height), ...u16be(width), 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, ...u16be(8), 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xd2, 0xcf, 0x20,
    0xff, 0xd9,
  ]);
}

/** An APPn segment of `size` bytes in total (marker included). */
function jpegSegment(marker: number, size: number): number[] {
  return [0xff, marker, ...u16be(size - 2), ...new Array<number>(size - 4).fill(0x41)];
}

function riff(chunk: string, data: readonly number[]): Uint8Array {
  const padded = data.length % 2 === 0 ? [...data] : [...data, 0];
  const body = [...ascii("WEBP"), ...ascii(chunk), ...u32le(data.length), ...padded];
  return new Uint8Array([...ascii("RIFF"), ...u32le(body.length), ...body]);
}

function webpLossless(width = 1, height = 1): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14) | (1 << 28)) >>> 0;
  return riff("VP8L", [0x2f, ...u32le(bits), 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]);
}

function webpLossy(width = 1, height = 1): Uint8Array {
  return riff("VP8 ", [
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height),
    0x01, 0x40, 0x26, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0x94, 0x00, 0x00,
  ]);
}

function webpExtended(width = 1, height = 1): Uint8Array {
  return riff("VP8X", [0x10, 0x00, 0x00, 0x00, ...u24le(width - 1), ...u24le(height - 1)]);
}

function box(type: string, ...content: (readonly number[])[]): number[] {
  const body = content.flat();
  return [...u32be(8 + body.length), ...ascii(type), ...body];
}

function fullBox(type: string, ...content: (readonly number[])[]): number[] {
  return box(type, [0, 0, 0, 0], ...content);
}

function ispe(width: number, height: number): number[] {
  return fullBox("ispe", u32be(width), u32be(height));
}

/** ftyp, meta (hdlr, pitm, iprp/ipco/ispe…), mdat. */
function avif(
  extents: ReadonlyArray<readonly [number, number]> = [[1, 1]],
  options: { brands?: readonly string[]; major?: string; mdatFirst?: boolean } = {},
): Uint8Array {
  const ftyp = box(
    "ftyp",
    ascii(options.major ?? "avif"),
    u32be(0),
    ...(options.brands ?? ["avif", "mif1", "miaf"]).map(ascii),
  );
  const meta = fullBox(
    "meta",
    fullBox("hdlr", u32be(0), ascii("pict"), new Array<number>(12).fill(0), [0]),
    fullBox("pitm", u16be(1)),
    box("iprp", box("ipco", ...extents.map(([width, height]) => ispe(width, height)))),
  );
  const mdat = box("mdat", [0x12, 0x00, 0x0a, 0x07]);

  return new Uint8Array(options.mdatFirst === true ? [...ftyp, ...mdat, ...meta] : [...ftyp, ...meta, ...mdat]);
}

function ico(entries: ReadonlyArray<readonly [number, number]> = [[16, 16]]): Uint8Array {
  const image = [...png(1, 1)];
  const directoryEnd = 6 + entries.length * 16;
  return new Uint8Array([
    0x00, 0x00, 0x01, 0x00, ...u16le(entries.length),
    ...entries.flatMap(([width, height], index) => [
      width, height, 0x00, 0x00, ...u16le(1), ...u16le(32),
      ...u32le(image.length), ...u32le(directoryEnd + index * image.length),
    ]),
    ...entries.flatMap(() => image),
  ]);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// Deterministic, so a failure reproduces.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const SAMPLES: ReadonlyArray<readonly [string, RasterImageType, Uint8Array]> = [
  ["png", "image/png", png(1, 1)],
  ["gif", "image/gif", gif(1, 1)],
  ["jpeg", "image/jpeg", jpeg(1, 1)],
  ["webp lossless", "image/webp", webpLossless(1, 1)],
  ["webp lossy", "image/webp", webpLossy(1, 1)],
  ["webp extended", "image/webp", webpExtended(1, 1)],
  ["avif", "image/avif", avif()],
  ["ico", "image/x-icon", ico([[1, 1]])],
];

// ── stated types ─────────────────────────────────────────────────────────────

describe("normalizeImageType", () => {
  it.each([
    ["image/jpeg", "image/jpeg"],
    ["image/jpg", "image/jpeg"],
    ["IMAGE/JPG", "image/jpeg"],
    ["image/png", "image/png"],
    ["image/webp", "image/webp"],
    ["image/gif", "image/gif"],
    ["image/avif", "image/avif"],
    ["image/x-icon", "image/x-icon"],
    ["image/vnd.microsoft.icon", "image/x-icon"],
    ["image/svg+xml", "image/svg+xml"],
  ])("reads %s as %s", (stated, canonical) => {
    expect(normalizeImageType(stated)).toBe(canonical);
  });

  it.each([
    "image/png; charset=binary",
    "text/html",
    "application/octet-stream",
    "image/heic",
    "image/bmp",
    "image/tiff",
    "constructor",
    "__proto__",
    "",
  ])("does not read %j as an image type", (stated) => {
    expect(normalizeImageType(stated)).toBeNull();
  });
});

// ── magic bytes ──────────────────────────────────────────────────────────────

describe("sniffImageType", () => {
  it.each(SAMPLES)("proves a %s from its bytes", (_label, type, bytes) => {
    expect(sniffImageType(bytes)).toBe(type);
  });

  it("recognises AVIF by a compatible brand as well as by the major one", () => {
    expect(sniffImageType(avif([[1, 1]], { brands: ["mif1", "avif"], major: "mif1" }))).toBe(
      "image/avif",
    );
    expect(sniffImageType(avif([[1, 1]], { brands: ["msf1", "avis"], major: "avis" }))).toBe(
      "image/avif",
    );
  });

  it.each([
    ["an empty file", new Uint8Array()],
    ["plain text", utf8("hello, world")],
    ["an SVG, which only checkSvg may call an SVG", utf8('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["HTML", utf8("<!doctype html><script>alert(1)</script>")],
    ["a PDF", utf8("%PDF-1.7\n%âãÏÓ\n")],
    ["a WAVE file", new Uint8Array([...ascii("RIFF"), ...u32le(4), ...ascii("WAVEfmt ")])],
    ["a RIFF WEBP without a known chunk", new Uint8Array([...ascii("RIFF"), ...u32le(8), ...ascii("WEBPJUNK")])],
    ["a HEIC file", avif([[1, 1]], { brands: ["mif1", "heic"], major: "heic" })],
    ["an MP4 file", avif([[1, 1]], { brands: ["isom", "mp41"], major: "isom" })],
    ["a cursor (type 2), not an icon", new Uint8Array([0, 0, 2, 0, 1, 0, ...new Array<number>(16).fill(0)])],
    ["an icon directory with no entry", new Uint8Array([0, 0, 1, 0, 0, 0, ...new Array<number>(16).fill(0)])],
    ["half a PNG signature", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ["a GIF signature without its version", utf8("GIF8")],
  ])("finds no raster type in %s", (_label, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });

  it("names the type the bytes have, not the one a sender states", () => {
    // A PNG sent as a JPEG, a GIF sent as a WebP: the sniff answers the truth,
    // and the upload compares it with the stated type.
    expect(sniffImageType(png())).toBe("image/png");
    expect(sniffImageType(png())).not.toBe(normalizeImageType("image/jpeg"));
    expect(sniffImageType(gif())).not.toBe(normalizeImageType("image/webp"));
  });

  it("reads a GIF header followed by markup as a GIF, never as an SVG", () => {
    const polyglot = utf8(
      'GIF89a<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
    );

    expect(sniffImageType(polyglot)).toBe("image/gif");
    expect(checkSvg(polyglot)).toEqual({ ok: false, reason: "not_svg" });
  });
});

// ── dimensions ───────────────────────────────────────────────────────────────

describe("readImageDimensions", () => {
  it.each([
    ["png", "image/png", png(640, 480), 640, 480],
    ["gif", "image/gif", gif(320, 200), 320, 200],
    ["jpeg", "image/jpeg", jpeg(1920, 1080), 1920, 1080],
    ["webp lossless", "image/webp", webpLossless(4000, 3000), 4000, 3000],
    ["webp lossy", "image/webp", webpLossy(1024, 768), 1024, 768],
    ["webp extended", "image/webp", webpExtended(16383, 20000), 16383, 20000],
    ["avif", "image/avif", avif([[2560, 1440]]), 2560, 1440],
    ["ico", "image/x-icon", ico([[48, 48]]), 48, 48],
  ] as const)("reads the size of a %s", (_label, type, bytes, width, height) => {
    expect(readImageDimensions(type, bytes)).toEqual({ height, width });
  });

  it("walks JPEG fill bytes and segments ahead of the frame header", () => {
    const padded = jpeg(800, 600, [0xff, 0xff, ...jpegSegment(0xe1, 300).slice(1), ...jpegSegment(0xfe, 20)]);

    expect(readImageDimensions("image/jpeg", padded)).toEqual({ height: 600, width: 800 });
  });

  it("asks for more when a large profile keeps the JPEG frame header out of the head", () => {
    const withProfile = jpeg(3000, 2000, [...jpegSegment(0xe2, 65_000), ...jpegSegment(0xe2, 20_000)]);
    const head = withProfile.subarray(0, 64 * 1024);

    expect(readImageDimensions("image/jpeg", head)).toBe("need_more");
    expect(readImageDimensions("image/jpeg", withProfile)).toEqual({ height: 2000, width: 3000 });
  });

  it("does not look past the start of a JPEG scan for a frame header", () => {
    const scanFirst = new Uint8Array([0xff, 0xd8, 0xff, 0xda, ...u16be(8), 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);

    expect(readImageDimensions("image/jpeg", scanFirst)).toBeNull();
  });

  it("takes the largest AVIF extent: the picture, not its thumbnail or tiles", () => {
    expect(
      readImageDimensions("image/avif", avif([[160, 90], [1920, 1080], [512, 512]])),
    ).toEqual({ height: 1080, width: 1920 });
  });

  it("gives up on an AVIF whose data comes before its description", () => {
    expect(readImageDimensions("image/avif", avif([[64, 64]], { mdatFirst: true }))).toBeNull();
  });

  it("reads 0 in an icon entry as 256 and takes the largest entry", () => {
    expect(readImageDimensions("image/x-icon", ico([[16, 16], [0, 0], [32, 32]]))).toEqual({
      height: 256,
      width: 256,
    });
  });

  it.each([
    ["a zero width", png(0, 10)],
    ["a width over 100000", png(100_001, 10)],
    ["a height over 100000", png(10, 4_000_000_000)],
  ])("records %s as unknown", (_label, bytes) => {
    expect(readImageDimensions("image/png", bytes)).toBeNull();
  });

  it("answers null, not a size, for bytes of another type", () => {
    expect(readImageDimensions("image/png", gif(10, 10))).toBeNull();
    expect(readImageDimensions("image/gif", png(10, 10))).toBeNull();
    expect(readImageDimensions("image/jpeg", png(10, 10))).toBeNull();
    expect(readImageDimensions("image/webp", png(10, 10))).toBeNull();
  });

  it.each(SAMPLES)("never throws on any truncation of a %s", (_label, type, bytes) => {
    const full = readImageDimensions(type, bytes);
    expect(full).toEqual({ height: 1, width: 1 });

    for (let length = 0; length <= bytes.length; length += 1) {
      const prefix = bytes.subarray(0, length);
      const result = readImageDimensions(type, prefix);
      // A prefix either has the size already, or asks for more, or (for a box
      // walk cut inside a child box) cannot tell: never another size.
      expect(result === "need_more" || result === null || (typeof result === "object" && result.width === 1)).toBe(
        true,
      );
      expect(() => sniffImageType(prefix)).not.toThrow();
    }
    // The shortest prefixes cannot hold a size at all.
    expect(readImageDimensions(type, bytes.subarray(0, 4))).toBe("need_more");
  });

  it.each(SAMPLES)("never throws on a hostile %s", (_label, type, bytes) => {
    const random = seededRandom(bytes.length * 7919);

    for (let round = 0; round < 400; round += 1) {
      const mutated = new Uint8Array(bytes);
      const edits = 1 + Math.floor(random() * 6);
      for (let edit = 0; edit < edits; edit += 1) {
        mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
      }
      // Some rounds also truncate.
      const cut = random() < 0.3 ? mutated.subarray(0, Math.floor(random() * mutated.length)) : mutated;

      const result = readImageDimensions(type, cut);
      if (typeof result === "object" && result !== null) {
        expect(result.width).toBeGreaterThanOrEqual(1);
        expect(result.height).toBeLessThanOrEqual(100_000);
      }
      expect(() => sniffImageType(cut)).not.toThrow();
    }
  });
});

// ── SVG ──────────────────────────────────────────────────────────────────────

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function svg(inner: string, attributes = 'width="120" height="40"'): Uint8Array {
  return utf8(`<svg ${SVG_NS} ${attributes}>${inner}</svg>`);
}

const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Logo, exported by hand -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="120" height="40" viewBox="0 0 120 40">
  <title>Shop &amp; Co</title>
  <defs>
    <linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1a1a1a"/><stop offset="1" stop-color="#555"/></linearGradient>
    <path id="mark" d="M10 10 L30 10 L20 30 Z"/>
  </defs>
  <style>.word { fill: url(#g); font-family: 'Helvetica Neue', sans-serif; }</style>
  <rect width="120" height="40" fill="url( '#g' )" rx="4"/>
  <use xlink:href="#mark" href="#mark"/>
  <image width="8" height="8" href="data:image/png;base64,iVBORw0KGgo="/>
  <text class="word" x="40" y="26">Shop &#38; Co</text>
</svg>
`;

const EDITOR_OUTPUT = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<!-- Created with an editor (http://editor.example/) -->
<svg
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xml:space="preserve"
   version="1.1"
   viewBox="0 0 210.5 99.2"
   width="100%">
  <metadata><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format><dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/></cc:Work></rdf:RDF></metadata>
  <sodipodi:namedview pagecolor="#ffffff" showgrid="false"/>
  <g style="fill:#000000;stroke:none"><circle cx="50" cy="50" r="40"/></g>
</svg>`;

describe("checkSvg — admitted", () => {
  it("admits a plain logo and reads its size from width and height", () => {
    expect(checkSvg(utf8(LOGO))).toEqual({ height: 40, ok: true, width: 120 });
  });

  it("admits typical editor output: DOCTYPE without a subset, metadata namespaces", () => {
    // width="100%" is not a plain number, so the size comes from viewBox.
    expect(checkSvg(utf8(EDITOR_OUTPUT))).toEqual({ height: 99, ok: true, width: 211 });
  });

  it("admits the shape of a desktop exporter's output: generator comment, style classes, xml:space", () => {
    const exported = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Vector Tool 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
\t viewBox="0 0 200 100" style="enable-background:new 0 0 200 100;" xml:space="preserve">
<style type="text/css">
\t.st0{fill:#FFFFFF;}
\t.st1{fill:none;stroke:#1D1D1B;stroke-width:2;stroke-miterlimit:10;}
\tsvg > g .st0{opacity:0.9;}
</style>
<g>
\t<rect x="0.5" y="0.5" class="st1" width="199" height="99"/>
\t<path class="st0" d="M20,20h40v40H20V20z"/>
</g>
</svg>
`;
    expect(checkSvg(utf8(exported))).toEqual({ height: 100, ok: true, width: 200 });
  });

  it("admits the shape of a design tool's output: clip paths, masks and filters by fragment", () => {
    const exported = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_1_2)" filter="url(#filter0_d_1_2)" mask="url(#m)">
<path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Z" fill="#0F172A"/>
</g>
<defs>
<filter id="filter0_d_1_2" x="0" y="0" width="24" height="24" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feFlood flood-opacity="0" result="BackgroundImageFix"/>
<feGaussianBlur stdDeviation="1"/>
</filter>
<mask id="m"><rect width="24" height="24" fill="white"/></mask>
<clipPath id="clip0_1_2"><rect width="24" height="24" fill="white"/></clipPath>
</defs>
</svg>
`;
    expect(checkSvg(utf8(exported))).toEqual({ height: 24, ok: true, width: 24 });
  });

  it("admits a file behind one UTF-8 byte-order mark", () => {
    expect(checkSvg(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(LOGO)]))).toMatchObject({ ok: true });
  });

  it.each([
    ['width="64px" height="32px"', 64, 32],
    ['width="10.4" height="10.6"', 10, 11],
    ['width="2em" height="1em" viewBox="0 0 300 150"', 300, 150],
    ['viewBox="-10,-10,40,20"', 40, 20],
  ])("reads the size from %s", (attributes, width, height) => {
    expect(checkSvg(svg("<g/>", attributes))).toEqual({ height, ok: true, width });
  });

  it.each([
    ['width="50%" height="50%"'],
    ['viewBox="0 0 0 0"'],
    ['width="200000" height="10"'],
    [""],
  ])("admits the file with an unknown size for %j", (attributes) => {
    expect(checkSvg(svg("<g/>", attributes))).toEqual({ height: null, ok: true, width: null });
  });
});

describe("checkSvg — refused", () => {
  const refusals: ReadonlyArray<readonly [string, SvgRefusal, Uint8Array]> = [
    ["over 512 KB", "too_large", svg(`<desc>${"a".repeat(SVG_MAX_BYTES)}</desc>`)],
    ["invalid UTF-8", "not_utf8", new Uint8Array([...utf8(`<svg ${SVG_NS}><text>`), 0xc3, 0x28, ...utf8("</text></svg>")])],
    ["an overlong UTF-8 '<'", "not_utf8", new Uint8Array([0xc0, 0xbc, ...utf8(`svg ${SVG_NS}/>`)])],
    [
      "UTF-16 behind its byte-order mark",
      "not_utf8",
      new Uint8Array([0xff, 0xfe, ...Array.from(`<svg ${SVG_NS}/>`).flatMap((c) => [c.charCodeAt(0), 0])]),
    ],
    [
      "UTF-16 without a byte-order mark",
      "invalid_character",
      new Uint8Array(Array.from(`<svg ${SVG_NS}/>`).flatMap((c) => [c.charCodeAt(0), 0])),
    ],
    ["a control character", "invalid_character", svg("<text>a\u0001b</text>")],
    ["a declared encoding other than UTF-8", "encoding", utf8(`<?xml version="1.0" encoding="ISO-8859-1"?><svg ${SVG_NS}/>`)],
    ["a second byte-order mark", "not_svg", new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8(`<svg ${SVG_NS}/>`)])],
    ["a root that is not svg", "not_svg", utf8("<html><body>hi</body></html>")],
    ["text ahead of the root", "not_svg", utf8(`hello <svg ${SVG_NS}/>`)],
    ["a DOCTYPE with an internal subset", "doctype_subset", utf8(`<!DOCTYPE svg [ <!ATTLIST svg x CDATA "1"> ]><svg ${SVG_NS}/>`)],
    ["a subset behind a quoted '>'", "doctype_subset", utf8(`<!DOCTYPE svg PUBLIC "a>b" "c" [ ]><svg ${SVG_NS}/>`)],
    ["an entity declaration", "entity_declaration", utf8(`<!DOCTYPE svg [<!ENTITY x "&#60;script&#62;">]><svg ${SVG_NS}>&x;</svg>`)],
    ["an entity declaration outside any DOCTYPE", "entity_declaration", svg('<!ENTITY lol "lol">')],
    ["an unknown entity reference", "entity_reference", svg("<text>&nbsp;</text>")],
    ["a reference to a character XML forbids", "entity_reference", svg("<text>&#0;</text>")],
    ["a style sheet processing instruction", "processing_instruction", utf8(`<?xml-stylesheet href="https://evil.example/x.css"?><svg ${SVG_NS}/>`)],
    ["a processing instruction after the root", "processing_instruction", svg("<?php echo 1; ?>")],
    ["a script element", "script", svg("<script>alert(1)</script>")],
    ["an upper-case script element", "script", svg("<SCRIPT>alert(1)</SCRIPT>")],
    ["a namespaced script element", "script", svg("<svg:script>alert(1)</svg:script>")],
    ["a script element split by a newline", "script", svg("<script\n>alert(1)</script\n>")],
    ["a script inside a comment", "script", svg("<!-- <script>alert(1)</script> -->")],
    ["a script after an empty comment", "script", svg("<!----><script>alert(1)</script>")],
    ["a script inside CDATA", "script", svg("<![CDATA[<script>alert(1)</script>]]>")],
    ["a script handler element", "script", svg('<handler type="application/ecmascript">alert(1)</handler>')],
    ["an event attribute", "event_attribute", svg("<g/>", `onload="alert(1)"`)],
    ["a mixed-case event attribute on its own line", "event_attribute", svg('<rect\n\tOnClick\n=\n"alert(1)"/>')],
    ["a namespaced event attribute", "event_attribute", svg('<rect xlink:onmouseover="alert(1)"/>')],
    ["an animation that sets an event attribute", "event_attribute", svg('<set attributeName="onclick" to="alert(1)"/>')],
    ["foreignObject", "foreign_content", svg('<foreignObject width="10" height="10"><div>x</div></foreignObject>')],
    ["the XHTML namespace", "foreign_content", svg('<h:img xmlns:h="http://www.w3.org/1999/xhtml" alt=""/>')],
    ["an entity-encoded XHTML namespace", "foreign_content", svg('<g xmlns="http://www.w3.org/1999/&#x78;html"/>')],
    ["a meta element", "foreign_content", svg('<meta http-equiv="refresh" content="0"/>')],
    ["an iframe", "embedded_content", svg('<iframe title="x"/>')],
    ["an embed", "embedded_content", svg('<embed type="image/png"/>')],
    ["an object", "embedded_content", svg('<object type="image/png"/>')],
    ["an outside href", "outside_reference", svg('<a href="https://evil.example/"><text>x</text></a>')],
    ["a use of another file", "outside_reference", svg('<use xlink:href="sprites.svg#icon"/>')],
    ["an image by address", "outside_reference", svg('<image href="//evil.example/x.png"/>')],
    ["a src attribute", "outside_reference", svg('<g src="https://evil.example/"/>')],
    ["an inline SVG image", "outside_reference", svg('<image href="data:image/svg+xml;base64,PHN2Zz4="/>')],
    ["an empty href", "outside_reference", svg('<use href=""/>')],
    ["xml:base", "outside_reference", svg('<g xml:base="https://evil.example/"><use href="#a"/></g>')],
    ["an animation that sets href", "outside_reference", svg('<use href="#a"><set attributeName="xlink:href" to="https://evil.example/x.svg#a"/></use>')],
    ["url() to another file in a style element", "outside_reference", svg("<style>rect { fill: url(https://evil.example/p.svg#g) }</style>")],
    ["url() to another file in a presentation attribute", "outside_reference", svg('<rect fill="url(//evil.example/p.svg#g)"/>')],
    ["url() by an entity-encoded address", "outside_reference", svg('<rect style="cursor: url(&#104;ttps://evil.example/c.png), auto"/>')],
    ["a comment inside url()", "outside_reference", svg("<style>rect { fill: url(/**/#g) }</style>")],
    ["image-set()", "outside_reference", svg(`<rect style='background: image-set("https://evil.example/x.png" 1x)'/>`)],
    ["javascript: in text", "javascript_url", svg("<text>javascript:alert(1)</text>")],
    ["javascript: behind a character reference", "javascript_url", svg('<animate attributeName="x" values="&#106;avascript:alert(1)"/>')],
    ["javascript: split by an encoded tab", "javascript_url", svg('<animate attributeName="x" values="java&#x09;script:alert(1)"/>')],
    ["javascript: in upper case", "javascript_url", svg('<animate attributeName="x" values="JaVaScRiPt:alert(1)"/>')],
    ["a CSS escape", "escape", svg("<style>rect { fill: u\\72l(https://evil.example/p.svg#g) }</style>")],
    ["@import", "style_import", svg("<style>@import 'https://evil.example/x.css';</style>")],
    ["@import inside CDATA", "style_import", svg("<style><![CDATA[ @IMPORT url(#x); ]]></style>")],
    ["an unterminated attribute value", "malformed", svg('<rect fill="red/>')],
    ["an attribute without a value", "malformed", svg("<rect hidden/>")],
    ["a '<' inside an attribute value", "malformed", svg('<rect title="a<b"/>')],
    ["a tag swallowed by an attribute value", "malformed", svg(`<!-- <a b=' --><script>alert(1)</script><g c='/>`)],
    ["a duplicated attribute", "malformed", svg('<rect fill="red" fill="blue"/>')],
    ["a stray '<'", "malformed", svg("<text>1 < 2</text>")],
    ["an unterminated comment before the root", "malformed", utf8(`<!-- <svg ${SVG_NS}/>`)],
  ];

  it.each(refusals)("refuses %s", (_label, reason, bytes) => {
    expect(checkSvg(bytes)).toEqual({ ok: false, reason });
  });

  it("names every refusal reason at least once", () => {
    const covered = new Set(refusals.map(([, reason]) => reason));
    const all: SvgRefusal[] = [
      "doctype_subset", "embedded_content", "encoding", "entity_declaration", "entity_reference",
      "escape", "event_attribute", "foreign_content", "invalid_character", "javascript_url",
      "malformed", "not_svg", "not_utf8", "outside_reference", "processing_instruction",
      "script", "style_import", "too_large",
    ];
    expect([...covered].sort()).toEqual(all);
  });

  it("never throws on any truncation of a valid logo", () => {
    const bytes = utf8(LOGO);
    for (let length = 0; length < bytes.length; length += 1) {
      expect(() => checkSvg(bytes.subarray(0, length))).not.toThrow();
    }
  });
});

describe("checkSvg reads the text as a parser joins it", () => {
  const svg = (inner: string): Uint8Array =>
    new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`);

  it.each([
    ["an import split by a CDATA marker", '<style>@im<![CDATA[port]]> "https://example.com/a.css";</style>', "style_import"],
    ["an import split by a comment", '<style>@im<!-- -->port "https://example.com/a.css";</style>', "style_import"],
    ["an import split by a child element", '<style>@im<g/>port "https://example.com/a.css";</style>', "style_import"],
    ["a url( split by a CDATA marker", "<style>a{fill:ur<![CDATA[l(]]>https://example.com/a.png)}</style>", "outside_reference"],
    ["a url( split by a comment", "<style>a{fill:ur<!--x-->l(https://example.com/a.png)}</style>", "outside_reference"],
    ["a script scheme split by a CDATA marker", "<style>a{x:java<![CDATA[script:]]>1}</style>", "javascript_url"],
  ])("refuses %s", (_label, inner, reason) => {
    expect(checkSvg(svg(inner))).toEqual({ ok: false, reason });
  });

  it("still admits a style sheet inside a CDATA section that fetches nothing", () => {
    expect(checkSvg(svg("<style><![CDATA[ .a{fill:#123456} ]]></style><rect class=\"a\" width=\"1\" height=\"1\"/>"))).toMatchObject({
      ok: true,
    });
  });
});
