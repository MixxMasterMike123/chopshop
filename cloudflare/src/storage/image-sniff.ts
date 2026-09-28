/**
 * The type and the pixel size of an image, taken from its own bytes (D92):
 * never from its name, its extension or the type its sender states.
 *
 * Pure: `Uint8Array` in, plain values out. No `env`, no I/O and nothing of the
 * Workers runtime, so the importer's copy tool can run the same rules under
 * Node. Every read checks the length first, so nothing here throws on a
 * truncated or hostile file.
 */

export type RasterImageType =
  | "image/avif"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/x-icon";

export type ImageType = RasterImageType | "image/svg+xml";

export interface ImageDimensions {
  height: number;
  width: number;
}

// Why an SVG was refused. The check refuses on doubt, so several reasons name
// constructs a logo never needs rather than proven attacks.
export type SvgRefusal =
  | "doctype_subset"
  | "embedded_content"
  | "encoding"
  | "entity_declaration"
  | "entity_reference"
  | "escape"
  | "event_attribute"
  | "foreign_content"
  | "invalid_character"
  | "javascript_url"
  | "malformed"
  | "not_svg"
  | "not_utf8"
  | "outside_reference"
  | "processing_instruction"
  | "script"
  | "style_import"
  | "too_large";

export type SvgCheckResult =
  | { height: number | null; ok: true; width: number | null }
  | { ok: false; reason: SvgRefusal };

// The largest side a row may record (0039's CHECK). A size outside 1..this is
// not an error: it is recorded as unknown.
export const IMAGE_DIMENSION_MAX = 100_000;
// D92: an SVG is at most 512 KB. checkSvg bounds its own work by it as well.
export const SVG_MAX_BYTES = 512 * 1024;

// The stated types this module understands, in every spelling it accepts.
// `image/jpg` and `image/vnd.microsoft.icon` are common non-canonical names.
const STATED_TYPES = new Map<string, ImageType>([
  ["image/avif", "image/avif"],
  ["image/gif", "image/gif"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"],
  ["image/svg+xml", "image/svg+xml"],
  ["image/vnd.microsoft.icon", "image/x-icon"],
  ["image/webp", "image/webp"],
  ["image/x-icon", "image/x-icon"],
]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const WEBP_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * The canonical form of a stated type, or null when it is not an image type
 * this module can prove. Case-insensitive; parameters are not accepted.
 */
export function normalizeImageType(stated: string): ImageType | null {
  return STATED_TYPES.get(stated.toLowerCase()) ?? null;
}

// ── binary reads ────────────────────────────────────────────────────────────

function hasBytes(bytes: Uint8Array, offset: number, count: number): boolean {
  return offset >= 0 && offset + count <= bytes.length;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function matchesAt(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return (
    hasBytes(bytes, offset, expected.length) &&
    expected.every((value, index) => bytes[offset + index] === value)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return matchesAt(
    bytes,
    offset,
    Array.from(text, (character) => character.charCodeAt(0)),
  );
}

function fourCharacterCode(bytes: Uint8Array, offset: number): string | null {
  if (!hasBytes(bytes, offset, 4)) {
    return null;
  }

  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function isGif(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a");
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    asciiAt(bytes, 0, "RIFF") &&
    asciiAt(bytes, 8, "WEBP") &&
    WEBP_CHUNKS.has(fourCharacterCode(bytes, 12) ?? "")
  );
}

function withinRange(width: number, height: number): ImageDimensions | null {
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= IMAGE_DIMENSION_MAX &&
    height <= IMAGE_DIMENSION_MAX
    ? { height, width }
    : null;
}

// ── magic bytes ─────────────────────────────────────────────────────────────

function isAvif(bytes: Uint8Array): boolean {
  if (fourCharacterCode(bytes, 4) !== "ftyp" || !hasBytes(bytes, 0, 16)) {
    return false;
  }

  // `ftyp`: size, "ftyp", major brand, minor version, compatible brands.
  const size = dataView(bytes).getUint32(0);
  if (size < 16 || size % 4 !== 0) {
    return false;
  }

  const end = Math.min(size, bytes.length);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    // Offset 12 is the minor version, a number rather than a brand.
    if (offset !== 12 && AVIF_BRANDS.has(fourCharacterCode(bytes, offset) ?? "")) {
      return true;
    }
  }

  return false;
}

function isIco(bytes: Uint8Array): boolean {
  if (!hasBytes(bytes, 0, 22)) {
    return false;
  }

  // ICONDIR: reserved 0, type 1 (icon, not cursor), at least one entry, and
  // room for that first 16-byte ICONDIRENTRY.
  const data = dataView(bytes);
  return (
    data.getUint16(0, true) === 0 &&
    data.getUint16(2, true) === 1 &&
    data.getUint16(4, true) >= 1
  );
}

/**
 * The raster type the first bytes prove, or null. An SVG is never recognised
 * here: it is text, and only `checkSvg` over the whole file may call a file an
 * SVG.
 */
export function sniffImageType(head: Uint8Array): RasterImageType | null {
  if (matchesAt(head, 0, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  if (matchesAt(head, 0, PNG_SIGNATURE)) {
    return "image/png";
  }
  if (isGif(head)) {
    return "image/gif";
  }
  if (isWebp(head)) {
    return "image/webp";
  }
  if (isAvif(head)) {
    return "image/avif";
  }

  return isIco(head) ? "image/x-icon" : null;
}

// ── dimensions ──────────────────────────────────────────────────────────────

type DimensionsResult = ImageDimensions | "need_more" | null;

function pngDimensions(bytes: Uint8Array): DimensionsResult {
  // Signature, then IHDR: length, "IHDR", width, height (big-endian).
  if (!hasBytes(bytes, 0, 24)) {
    return "need_more";
  }
  if (
    !matchesAt(bytes, 0, PNG_SIGNATURE) ||
    fourCharacterCode(bytes, 12) !== "IHDR"
  ) {
    return null;
  }

  const data = dataView(bytes);
  return withinRange(data.getUint32(16), data.getUint32(20));
}

function gifDimensions(bytes: Uint8Array): DimensionsResult {
  // "GIF87a"/"GIF89a", then the logical screen's width and height.
  if (!hasBytes(bytes, 0, 10)) {
    return "need_more";
  }
  if (!isGif(bytes)) {
    return null;
  }

  const data = dataView(bytes);
  return withinRange(data.getUint16(6, true), data.getUint16(8, true));
}

function webpDimensions(bytes: Uint8Array): DimensionsResult {
  if (!hasBytes(bytes, 0, 16)) {
    return "need_more";
  }
  if (!isWebp(bytes)) {
    return null;
  }

  const data = dataView(bytes);
  const chunk = fourCharacterCode(bytes, 12);

  if (chunk === "VP8 ") {
    // Lossy: frame tag (3), start code 9D 01 2A, then 14-bit width and height.
    if (!hasBytes(bytes, 0, 30)) {
      return "need_more";
    }
    if (!matchesAt(bytes, 23, [0x9d, 0x01, 0x2a])) {
      return null;
    }
    return withinRange(
      data.getUint16(26, true) & 0x3fff,
      data.getUint16(28, true) & 0x3fff,
    );
  }

  if (chunk === "VP8L") {
    // Lossless: signature 0x2F, then width-1 and height-1 in 14 bits each.
    if (!hasBytes(bytes, 0, 25)) {
      return "need_more";
    }
    if (bytes[20] !== 0x2f) {
      return null;
    }
    const bits = data.getUint32(21, true);
    return withinRange((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  // Extended (VP8X): flags (1), reserved (3), canvas width-1 and height-1 in
  // 24 bits each.
  if (!hasBytes(bytes, 0, 30)) {
    return "need_more";
  }
  const width = data.getUint16(24, true) + (data.getUint8(26) << 16) + 1;
  const height = data.getUint16(27, true) + (data.getUint8(29) << 16) + 1;
  return withinRange(width, height);
}

function isStandaloneJpegMarker(marker: number): boolean {
  // TEM, RST0–RST7 and a repeated SOI carry no length.
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

function isJpegFrameHeader(marker: number): boolean {
  // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpegDimensions(bytes: Uint8Array): DimensionsResult {
  if (!hasBytes(bytes, 0, 2)) {
    return "need_more";
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  const data = dataView(bytes);
  let offset = 2;

  // Each step moves forward by at least one byte, so the walk ends within the
  // bytes at hand.
  for (;;) {
    if (!hasBytes(bytes, offset, 1)) {
      return "need_more";
    }
    if (bytes[offset] !== 0xff) {
      return null;
    }
    // A marker may be padded with any number of 0xFF fill bytes.
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    if (!hasBytes(bytes, offset, 1)) {
      return "need_more";
    }

    const marker = data.getUint8(offset);
    offset += 1;
    if (isStandaloneJpegMarker(marker)) {
      continue;
    }
    // End of image, start of scan or a stuffed byte before any frame header:
    // the size is not ahead of the data.
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) {
      return null;
    }

    if (!hasBytes(bytes, offset, 2)) {
      return "need_more";
    }
    const length = data.getUint16(offset);
    if (length < 2) {
      return null;
    }

    if (isJpegFrameHeader(marker)) {
      // Length (2), precision (1), height (2), width (2), components (1).
      if (length < 8) {
        return null;
      }
      if (!hasBytes(bytes, offset, 7)) {
        return "need_more";
      }
      return withinRange(data.getUint16(offset + 5), data.getUint16(offset + 3));
    }

    offset += length;
  }
}

interface IsoBox {
  contentStart: number;
  end: number;
  type: string;
}

// The ISO-BMFF box whose header starts at `offset`. Its content may run past
// the bytes at hand; callers check `end` before reading inside it.
function readBox(
  bytes: Uint8Array,
  data: DataView,
  offset: number,
): IsoBox | "need_more" | null {
  if (!hasBytes(bytes, offset, 8)) {
    return "need_more";
  }

  const type = fourCharacterCode(bytes, offset + 4) ?? "";
  const size32 = data.getUint32(offset);
  let size = size32;
  let header = 8;

  if (size32 === 1) {
    // 64-bit size. A box of 4 GiB or more cannot be in an admitted file.
    if (!hasBytes(bytes, offset + 8, 8)) {
      return "need_more";
    }
    if (data.getUint32(offset + 8) !== 0) {
      return null;
    }
    size = data.getUint32(offset + 12);
    header = 16;
  } else if (size32 === 0) {
    // "Runs to the end of the file": only a last box does that, and no box
    // this walk looks for is ever last.
    return null;
  }

  return size < header
    ? null
    : { contentStart: offset + header, end: offset + size, type };
}

// The direct children of a box that is wholly in the bytes, or null when one
// of them is malformed.
function childBoxes(
  bytes: Uint8Array,
  data: DataView,
  start: number,
  end: number,
): IsoBox[] | null {
  const children: IsoBox[] = [];
  let offset = start;

  while (offset < end) {
    const box = readBox(bytes, data, offset);
    if (box === null || box === "need_more" || box.end > end) {
      return null;
    }
    children.push(box);
    offset = box.end;
  }

  return children;
}

function avifDimensions(bytes: Uint8Array): DimensionsResult {
  const data = dataView(bytes);
  let offset = 0;

  // Top level: find `meta` (ftyp, meta, …, mdat). Every box is at least eight
  // bytes long, so the walk ends within the bytes at hand.
  for (;;) {
    const box = readBox(bytes, data, offset);
    if (box === null || box === "need_more") {
      return box;
    }
    if (box.type === "mdat") {
      // The image data comes before its description: not within a bounded read.
      return null;
    }
    if (box.type === "meta") {
      if (box.end > bytes.length) {
        return "need_more";
      }
      return largestSpatialExtent(bytes, data, box);
    }
    offset = box.end;
  }
}

// meta (a full box) → iprp → ipco → every `ispe`. A file can describe several
// images (a grid and its tiles, a thumbnail, an alpha plane); the largest is
// the picture itself.
function largestSpatialExtent(
  bytes: Uint8Array,
  data: DataView,
  meta: IsoBox,
): ImageDimensions | null {
  const properties = childBoxes(bytes, data, meta.contentStart + 4, meta.end)
    ?.find((box) => box.type === "iprp");
  const container =
    properties === undefined
      ? undefined
      : childBoxes(bytes, data, properties.contentStart, properties.end)?.find(
          (box) => box.type === "ipco",
        );
  const extents =
    container === undefined
      ? []
      : (childBoxes(bytes, data, container.contentStart, container.end) ?? []);

  let largest: ImageDimensions | null = null;
  for (const box of extents) {
    // ispe: version and flags (4), width (4), height (4).
    if (box.type !== "ispe" || box.contentStart + 12 > box.end) {
      continue;
    }
    const size = withinRange(
      data.getUint32(box.contentStart + 4),
      data.getUint32(box.contentStart + 8),
    );
    if (
      size !== null &&
      (largest === null || size.width * size.height > largest.width * largest.height)
    ) {
      largest = size;
    }
  }

  return largest;
}

function icoDimensions(bytes: Uint8Array): DimensionsResult {
  if (!hasBytes(bytes, 0, 6)) {
    return "need_more";
  }

  const data = dataView(bytes);
  const count = data.getUint16(4, true);
  if (data.getUint16(0, true) !== 0 || data.getUint16(2, true) !== 1 || count === 0) {
    return null;
  }
  if (!hasBytes(bytes, 6, count * 16)) {
    return "need_more";
  }

  // One 16-byte entry per image; a width or height byte of 0 means 256.
  let largest: ImageDimensions | null = null;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const size = withinRange(
      data.getUint8(entry) || 256,
      data.getUint8(entry + 1) || 256,
    );
    if (
      size !== null &&
      (largest === null || size.width * size.height > largest.width * largest.height)
    ) {
      largest = size;
    }
  }

  return largest;
}

/**
 * The pixel size a raster file states about itself. "need_more" when the bytes
 * end before the size does (the caller may read a further range, or record
 * the size as unknown); null when the file does not carry it where this bounded
 * read looks, or carries one outside 1..IMAGE_DIMENSION_MAX.
 */
export function readImageDimensions(
  type: RasterImageType,
  bytes: Uint8Array,
): ImageDimensions | "need_more" | null {
  switch (type) {
    case "image/avif":
      return avifDimensions(bytes);
    case "image/gif":
      return gifDimensions(bytes);
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/png":
      return pngDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
    case "image/x-icon":
      return icoDimensions(bytes);
  }
}

// ── SVG ─────────────────────────────────────────────────────────────────────
//
// A refusing scan of the text, not a parser and not a sanitiser (D92). It
// never skips anything: comments, CDATA sections and text are scanned exactly
// like markup, so no construct can hide a tag from it; a tag inside a comment
// is refused like any other. Every `<` in the file is either read as the start
// of a tag, a declaration or an end tag, or makes the file malformed. Whatever
// the scan cannot read with certainty refuses.

// Fatal: bytes that are not UTF-8 throw rather than decode to U+FFFD. One
// leading UTF-8 byte-order mark is dropped; any other byte-order mark is
// either not UTF-8 or a character in front of the root, and refuses.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Characters XML 1.0 does not allow at all. A NUL also betrays UTF-16 text
// without a byte-order mark, whose bytes are valid UTF-8.
const INVALID_XML_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
// A character reference or one of XML's five predefined entities. Anything
// else after `&` needs a declaration, and declarations are refused.
const REFERENCE = /^&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|(lt|gt|amp|quot|apos));/;
const PREDEFINED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

const SCRIPT_ELEMENTS = new Set(["handler", "listener", "script"]);
const FOREIGN_ELEMENTS = new Set(["base", "foreignobject", "link", "meta"]);
const EMBEDDING_ELEMENTS = new Set([
  "applet",
  "audio",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "object",
  "video",
]);
// Attributes a browser follows to fetch or navigate.
const REFERENCE_ATTRIBUTES = new Set(["href", "ping", "src"]);
// The only outside content a reference may carry: a raster image inline.
const RASTER_DATA_URL = /^data:image\/(?:avif|gif|jpeg|jpg|png|webp)[;,]/;
// CSS functions that fetch from a string without `url(`.
const FETCHING_CSS_FUNCTIONS = ["image-set(", "src("];

const PLAIN_LENGTH = /^([0-9]+(?:\.[0-9]+)?)(?:px)?$/;
const VIEW_BOX_NUMBER = /^-?[0-9]+(?:\.[0-9]+)?$/;

interface Tag {
  attributes: Map<string, string>;
  end: number;
  name: string;
}

function refuse(reason: SvgRefusal): SvgCheckResult {
  return { ok: false, reason };
}

function isXmlSpace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

// Lowercase ASCII only: the length and every other character stay as they
// are. XML names and URL schemes are ASCII; CSS compares ASCII-insensitively.
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

// Character references and the five predefined entities resolved, exactly
// once, as an XML parser does. Null when a reference is unknown or names a
// character XML does not allow.
function decodeReferences(text: string): string | null {
  let decoded = "";
  let index = 0;

  for (;;) {
    const ampersand = text.indexOf("&", index);
    if (ampersand === -1) {
      return decoded + text.slice(index);
    }

    const match = REFERENCE.exec(text.slice(ampersand, ampersand + 12));
    if (match === null) {
      return null;
    }

    let replacement: string | undefined;
    if (match[3] !== undefined) {
      replacement = PREDEFINED_ENTITIES.get(match[3]);
    } else {
      const codePoint =
        match[1] !== undefined ? Number(match[1]) : Number.parseInt(match[2] ?? "", 16);
      const isXmlCharacter =
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      replacement = isXmlCharacter ? String.fromCodePoint(codePoint) : undefined;
    }
    if (replacement === undefined) {
      return null;
    }

    decoded += text.slice(index, ampersand) + replacement;
    index = ampersand + match[0].length;
  }
}

// Where the DOCTYPE starting at `start` ends, reading quoted strings as
// strings: "subset" when it opens an internal subset, null when unterminated.
function doctypeEnd(text: string, start: number): number | "subset" | null {
  let index = start + "<!doctype".length;

  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") {
      const close = text.indexOf(character, index + 1);
      if (close === -1) {
        return null;
      }
      index = close + 1;
      continue;
    }
    if (character === "[") {
      return "subset";
    }
    if (character === ">") {
      return index;
    }
    index += 1;
  }

  return null;
}

// The XML declaration, when the file starts with one: where it ends, or why it
// refuses. Only UTF-8 may be declared, since UTF-8 is what was scanned.
function xmlDeclarationEnd(text: string): number | SvgRefusal | null {
  if (!text.startsWith("<?xml") || !isXmlSpace(text[5])) {
    return null;
  }

  const end = text.indexOf("?>", 5);
  if (end === -1) {
    return "malformed";
  }

  const declaration = text.slice(0, end);
  if (!declaration.includes("encoding")) {
    return end + 2;
  }
  const encoding = /encoding\s*=\s*(["'])([^"']*)\1/.exec(declaration);
  return encoding?.[2] === "utf-8" ? end + 2 : "encoding";
}

// What may precede the root: the XML declaration, white space, comments and a
// DOCTYPE without an internal subset. Returns where the root `<svg` starts.
function rootStart(text: string): number | SvgRefusal {
  const declarationEnd = xmlDeclarationEnd(text);
  if (typeof declarationEnd === "string") {
    return declarationEnd;
  }

  let index = declarationEnd ?? 0;
  for (;;) {
    while (isXmlSpace(text[index])) {
      index += 1;
    }
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      if (close === -1) {
        return "malformed";
      }
      index = close + 3;
      continue;
    }
    if (text.startsWith("<!doctype", index)) {
      const end = doctypeEnd(text, index);
      if (end === null) {
        return "malformed";
      }
      if (end === "subset") {
        return "doctype_subset";
      }
      index = end + 1;
      continue;
    }
    if (text.startsWith("<?", index)) {
      return "processing_instruction";
    }
    break;
  }

  if (text[index] !== "<") {
    return "not_svg";
  }
  let nameEnd = index + 1;
  while (
    nameEnd < text.length &&
    !isXmlSpace(text[nameEnd]) &&
    text[nameEnd] !== "/" &&
    text[nameEnd] !== ">"
  ) {
    nameEnd += 1;
  }

  return localName(text.slice(index + 1, nameEnd)) === "svg" ? index : "not_svg";
}

function isNameStart(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (/[a-z_:]/.test(character) || character.charCodeAt(0) >= 0x80)
  );
}

// A start tag, read the way an XML parser reads one: a name, then attributes,
// each `name = "value"` or `name = 'value'`, then `>` or `/>`. Anything else,
// including a `<` inside a value, is malformed.
function readTag(text: string, start: number): Tag | SvgRefusal {
  let index = start + 1;
  if (!isNameStart(text[index])) {
    return "malformed";
  }
  while (index < text.length && !/[\s/>"'=<]/.test(text[index] ?? "")) {
    index += 1;
  }
  const name = text.slice(start + 1, index);
  const attributes = new Map<string, string>();

  for (;;) {
    while (isXmlSpace(text[index])) {
      index += 1;
    }

    const character = text[index];
    if (character === ">") {
      return { attributes, end: index + 1, name };
    }
    if (character === "/") {
      return text[index + 1] === ">"
        ? { attributes, end: index + 2, name }
        : "malformed";
    }

    const nameStart = index;
    while (index < text.length && !/[\s/>"'=<]/.test(text[index] ?? "")) {
      index += 1;
    }
    const attributeName = text.slice(nameStart, index);
    if (attributeName.length === 0 || attributes.has(attributeName)) {
      return "malformed";
    }

    while (isXmlSpace(text[index])) {
      index += 1;
    }
    if (text[index] !== "=") {
      return "malformed";
    }
    index += 1;
    while (isXmlSpace(text[index])) {
      index += 1;
    }

    const quote = text[index];
    if (quote !== '"' && quote !== "'") {
      return "malformed";
    }
    const close = text.indexOf(quote, index + 1);
    if (close === -1) {
      return "malformed";
    }
    const value = text.slice(index + 1, close);
    if (value.includes("<")) {
      return "malformed";
    }

    attributes.set(attributeName, value);
    index = close + 1;
  }
}

function isSafeReference(value: string): boolean {
  // As a URL parser reads it: tabs and newlines removed anywhere, spaces and
  // controls trimmed at both ends.
  const url = value
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");

  return url.startsWith("#") || RASTER_DATA_URL.test(url);
}

function elementRefusal(name: string): SvgRefusal | null {
  const local = localName(name);

  if (SCRIPT_ELEMENTS.has(local)) {
    return "script";
  }
  if (FOREIGN_ELEMENTS.has(local)) {
    return "foreign_content";
  }

  return EMBEDDING_ELEMENTS.has(local) ? "embedded_content" : null;
}

function attributeRefusal(name: string, rawValue: string): SvgRefusal | null {
  const local = localName(name);
  if (name.startsWith("on") || local.startsWith("on")) {
    return "event_attribute";
  }

  const decoded = decodeReferences(rawValue);
  if (decoded === null) {
    return "entity_reference";
  }
  const value = asciiLowerCase(decoded);

  if (REFERENCE_ATTRIBUTES.has(local)) {
    return isSafeReference(value) ? null : "outside_reference";
  }
  if (name === "xml:base") {
    return "outside_reference";
  }
  if (name === "xmlns" || name.startsWith("xmlns:")) {
    // Elements in the XHTML or MathML namespace run, load and link by rules
    // of their own; an SVG never needs them.
    return value.includes("xhtml") || value.includes("mathml")
      ? "foreign_content"
      : null;
  }
  if (local === "attributename") {
    // SMIL can set a reference or an event attribute after the scan.
    const target = localName(value.trim());
    if (target.includes("href")) {
      return "outside_reference";
    }
    return target.startsWith("on") ? "event_attribute" : null;
  }

  return null;
}

// Every `<` of the file, in order. Returns the root's attributes.
function scanMarkup(
  text: string,
  rootIndex: number,
): Map<string, string> | SvgRefusal {
  let rootAttributes: Map<string, string> | null = null;
  let index = text.indexOf("<");

  while (index !== -1) {
    let resume = index + 1;

    if (text.startsWith("<!", index)) {
      // Comments and CDATA sections are not skipped: their content is scanned
      // like everything else.
      if (text.startsWith("<!doctype", index)) {
        const end = doctypeEnd(text, index);
        if (end === null) {
          return "malformed";
        }
        if (end === "subset") {
          return "doctype_subset";
        }
      } else if (
        !text.startsWith("<!--", index) &&
        !text.startsWith("<![cdata[", index)
      ) {
        // <!ELEMENT, <!ATTLIST, <!NOTATION: declarations that only a subset
        // holds (checkSvg has already refused <!ENTITY).
        return "doctype_subset";
      }
    } else if (text.startsWith("<?", index)) {
      // Only the XML declaration, and only at the very start (rootStart has
      // read it).
      if (index !== 0 || xmlDeclarationEnd(text) === null) {
        return "processing_instruction";
      }
    } else if (text[index + 1] !== "/") {
      const tag = readTag(text, index);
      if (typeof tag === "string") {
        return tag;
      }

      const refusal = elementRefusal(tag.name);
      if (refusal !== null) {
        return refusal;
      }
      for (const [name, value] of tag.attributes) {
        const attributeProblem = attributeRefusal(name, value);
        if (attributeProblem !== null) {
          return attributeProblem;
        }
      }

      if (index === rootIndex) {
        rootAttributes = tag.attributes;
      }
      resume = tag.end;
    }

    index = text.indexOf("<", resume);
  }

  return rootAttributes ?? "not_svg";
}

// Text-wide scans, on the raw text and on the text with its references
// resolved: whatever the markup scan cannot place (style sheets, style
// attributes, presentation attributes, animation values) is caught here.
function textRefusal(texts: readonly string[]): SvgRefusal | null {
  for (const text of texts) {
    // A URL parser drops tabs and newlines inside a scheme.
    if (text.replace(/\s+/g, "").includes("javascript:")) {
      return "javascript_url";
    }
    // CSS escapes can spell `url(` or `@import` without those letters.
    if (text.includes("\\")) {
      return "escape";
    }
    if (text.includes("@import")) {
      return "style_import";
    }
    if (FETCHING_CSS_FUNCTIONS.some((name) => text.includes(name))) {
      return "outside_reference";
    }
    for (const match of text.matchAll(/url\(/g)) {
      const argument = text.slice(match.index + 4, match.index + 4 + 64);
      if (!/^\s*["']?\s*#/.test(argument)) {
        return "outside_reference";
      }
    }
  }

  return null;
}

/**
 * The text as a parser joins it: comments, CDATA markers and tags removed, so
 * what stood on both sides of one stands together. Over-approximate on
 * purpose (a `>` inside an attribute value ends the removal early): the result
 * is only ever scanned for what refuses.
 */
function joinedText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replaceAll("<![cdata[", "")
    .replaceAll("]]>", "")
    .replace(/<[^>]*>/g, "");
}

function roundedSide(value: number): number | null {
  const side = Math.round(value);
  return side >= 1 && side <= IMAGE_DIMENSION_MAX ? side : null;
}

function plainLength(value: string | undefined): number | null {
  const match = value === undefined ? null : PLAIN_LENGTH.exec(value.trim());
  return match?.[1] === undefined ? null : roundedSide(Number(match[1]));
}

// From `width`/`height` when both are plain numbers (user units, optionally
// "px"), else from `viewBox`, else unknown.
function svgDimensions(attributes: ReadonlyMap<string, string>): {
  height: number | null;
  width: number | null;
} {
  const resolved = (name: string): string | undefined => {
    const raw = attributes.get(name);
    return raw === undefined ? undefined : (decodeReferences(raw) ?? undefined);
  };

  const width = plainLength(resolved("width"));
  const height = plainLength(resolved("height"));
  if (width !== null && height !== null) {
    return { height, width };
  }

  const viewBox = resolved("viewbox")?.trim().split(/[\s,]+/);
  if (
    viewBox !== undefined &&
    viewBox.length === 4 &&
    viewBox.every((part) => VIEW_BOX_NUMBER.test(part))
  ) {
    const boxWidth = roundedSide(Number(viewBox[2]));
    const boxHeight = roundedSide(Number(viewBox[3]));
    if (boxWidth !== null && boxHeight !== null) {
      return { height: boxHeight, width: boxWidth };
    }
  }

  return { height: null, width: null };
}

/**
 * D92: an SVG is admitted only when this finds nothing that can run or fetch.
 * Refused, never repaired: a script element, an event attribute, foreign or
 * embedded content, a reference that is not a fragment or an inline raster
 * image, `javascript:` anywhere, `url(` that is not a fragment or `@import`
 * anywhere, a DOCTYPE with an internal subset, any entity declaration, a
 * processing instruction other than the XML declaration, bytes that are not
 * UTF-8, and whatever the scan cannot read with certainty. The size comes from
 * the root's `width`/`height` or `viewBox` when they are plain numbers.
 */
export function checkSvg(bytes: Uint8Array): SvgCheckResult {
  if (bytes.length > SVG_MAX_BYTES) {
    return refuse("too_large");
  }

  let decodedBytes: string;
  try {
    decodedBytes = UTF8.decode(bytes);
  } catch {
    return refuse("not_utf8");
  }
  if (INVALID_XML_CHARACTER.test(decodedBytes)) {
    return refuse("invalid_character");
  }

  const text = asciiLowerCase(decodedBytes);
  // Wherever it sits: inside a DOCTYPE's subset (the usual place) or not.
  if (text.includes("<!entity")) {
    return refuse("entity_declaration");
  }
  // References name only characters XML allows, so the resolved text needs
  // no second character check.
  const resolved = decodeReferences(text);
  if (resolved === null) {
    return refuse("entity_reference");
  }
  const resolvedText = asciiLowerCase(resolved);

  const rootIndex = rootStart(text);
  if (typeof rootIndex === "string") {
    return refuse(rootIndex);
  }

  const rootAttributes = scanMarkup(text, rootIndex);
  if (typeof rootAttributes === "string") {
    return refuse(rootAttributes);
  }

  // An XML parser joins the text on both sides of a comment, a CDATA marker
  // or a child element into ONE text: `@im<![CDATA[port]]>` is `@import` to
  // the style sheet. So the text-wide scans also read the text as joined,
  // with every such construct taken out, raw and with its references resolved.
  const joined = joinedText(text);
  const problem = textRefusal([
    text,
    resolvedText,
    joined,
    asciiLowerCase(decodeReferences(joined) ?? joined),
  ]);
  if (problem !== null) {
    return refuse(problem);
  }

  return { ok: true, ...svgDimensions(rootAttributes) };
}
