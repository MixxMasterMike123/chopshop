/**
 * The refusal at write of a page's HTML (CP4 brief C, "Content is HTML").
 *
 * A refusing scan of the text, modelled on the SVG check of
 * src/storage/image-sniff.ts: not a parser and not a sanitiser. It never
 * repairs: content is admitted as it is, or refused with one reason. The
 * storefront still cleans what it renders (DOMPurify in DynamicPage.jsx);
 * this is the server's own fence in front of it.
 *
 * What is refused (the brief's list first, then what the same rule, "a doubt
 * refuses", adds):
 *   - a `script`, `iframe`, `object` or `embed` element, and every other
 *     element that runs, embeds, submits, changes the document around the
 *     page, or switches the HTML tokenizer out of its ordinary state: raw-text
 *     and RCDATA elements (`style`, `title`, `textarea`, `xmp`, `noscript`,
 *     `noembed`, `noframes`, `plaintext`, `template`), SVG and MathML (foreign
 *     content), forms, `base`/`link`/`meta` and the document's own
 *     `html`/`head`/`body`;
 *   - an attribute whose name starts with `on`, `srcdoc`, `action` and
 *     `formaction`;
 *   - an address (`href`, `src`, `srcset`, …) whose scheme is not http,
 *     https, mailto or tel — `javascript:`, `data:`, `vbscript:` and the
 *     rest — or that the URL parser might read as carrying a scheme;
 *   - `javascript:` or `vbscript:` anywhere in the text, white space removed;
 *   - a `style` attribute that calls any CSS function but a colour or
 *     arithmetic one (so no `url(`, `image-set(`, `expression(`), or holds
 *     `@` (`@import`) or a backslash (a CSS escape can spell either);
 *   - an address of the source system's storage (Firebase), which dies with
 *     the store: an image of a page is a public object (CP4 brief C);
 *   - namespaced names, declarations (DOCTYPE, CDATA, bogus comments),
 *     processing instructions, character references other than numeric ones
 *     and `&amp; &lt; &gt; &quot; &apos; &nbsp;` inside a tag, control
 *     characters, lone surrogates, and whatever the scan cannot read with
 *     certainty ("malformed").
 *
 * HOW NOTHING CAN HIDE. The whole text is ASCII-lower-cased first (HTML names
 * are ASCII case-insensitive). Then EVERY `<` is visited in order and is read
 * as a comment opening, a start tag or an end tag, or refuses. A tag is read
 * the way the HTML tokenizer reads one in its data state; wherever this scan
 * and the tokenizer could part ways it refuses instead (an unquoted value
 * holding a quote, `=`, `<` or a backtick; a `/` that is not the tag's end; a
 * value in quotes followed by anything but white space, `/>` or `>`; a
 * duplicate attribute). A value that holds `<` refuses too, so no tag read
 * here ever spans a `<`: every `<` a browser could start a tag at is visited
 * here as a tag start. Comments are NOT skipped — their content is scanned
 * like everything else, so a tag inside a comment is refused like any other,
 * and neither `--!>` nor `<!-->` can end one early behind the scan's back. The
 * elements that would switch the tokenizer into another state (raw text,
 * RCDATA, script data, foreign content) are refused, so the data state is the
 * only state the accepted text is ever read in.
 */

export type HtmlRefusal =
  | "declaration"
  | "document_element"
  | "embedded_content"
  | "entity_reference"
  | "escape"
  | "event_attribute"
  | "foreign_content"
  | "form"
  | "invalid_character"
  | "javascript_url"
  | "malformed"
  | "processing_instruction"
  | "raw_text_element"
  | "script"
  | "storage_address"
  | "too_large"
  | "unsafe_address"
  | "unsafe_style";

export type HtmlCheckResult = { ok: true } | { ok: false; reason: HtmlRefusal };

/**
 * The scan bounds its own work: no page text is longer than the stored
 * content of a whole page (0042's CHECK, 262 144 bytes).
 */
export const HTML_MAX_LENGTH = 262_144;

// C0 controls except tab, line feed and carriage return; DEL. Form feed is
// white space to the tokenizer but never in an editor's output, so it refuses
// with the rest rather than be a second kind of white space.
const INVALID_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const SCRIPT_ELEMENTS = new Set(["script"]);
const EMBEDDING_ELEMENTS = new Set([
  "applet",
  "embed",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "object",
  "portal",
]);
// SVG and MathML switch the tokenizer to foreign content; the others exist
// only there and take part in the parser's namespace rules.
const FOREIGN_ELEMENTS = new Set([
  "annotation-xml",
  "foreignobject",
  "malignmark",
  "math",
  "mglyph",
  "svg",
]);
// Elements whose content the tokenizer reads as raw text or RCDATA (or, for
// `template`, keeps inert and re-parses): a `<` inside them is not a tag.
const RAW_TEXT_ELEMENTS = new Set([
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
]);
const FORM_ELEMENTS = new Set(["button", "form", "input", "isindex", "keygen", "select"]);
// They change the document around the page: its base address, its links, a
// refresh, or (for html/head/body) the attributes of the real elements.
const DOCUMENT_ELEMENTS = new Set(["base", "body", "head", "html", "link", "meta"]);

const FORM_ATTRIBUTES = new Set(["action", "formaction"]);
// Attributes whose value a browser resolves as one or more addresses.
const ADDRESS_ATTRIBUTES = new Set([
  "archive",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "dynsrc",
  "href",
  "icon",
  "imagesrcset",
  "itemid",
  "itemtype",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcset",
  "usemap",
]);
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
// A `srcset` descriptor (`2x`, `640w`), not an address.
const SRCSET_DESCRIPTOR = /^[0-9]+(?:\.[0-9]+)?[hwx]$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/;
// The CSS functions a style attribute may call: colours and arithmetic. None
// of them fetches.
const STYLE_FUNCTIONS = new Set(["calc", "clamp", "hsl", "hsla", "max", "min", "rgb", "rgba", "var"]);
// Hosts of the source system's storage. `%2e` is read as a dot: the URL
// parser percent-decodes a host.
const STORAGE_HOSTS = [
  "appspot.com",
  "firebasestorage.app",
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
];

// Inside a tag: a numeric character reference or one of six named ones, each
// with its semicolon. Anything else after `&` that a browser could read as a
// reference (a letter, a digit or `#`) refuses: HTML knows two thousand names
// (`&colon;`, `&Tab;`, `&NewLine;`), and some decode without a semicolon.
const REFERENCE = /^&(?:#([0-9]{1,7});|#x([0-9a-f]{1,6});|(amp|apos|gt|lt|nbsp|quot);)/;
const REFERENCE_START = /[a-z0-9#]/;
const NAMED_REFERENCES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

const TAG_NAME_CHARACTER = /[a-z0-9-]/;
const ATTRIBUTE_NAME_CHARACTER = /[a-z0-9_.-]/;
const LETTER = /[a-z]/;
// Characters HTML reads into an unquoted value only as a parse error.
const UNQUOTED_VALUE_REFUSED = /["'<=`]/;

interface Attribute {
  name: string;
  value: string;
}

interface Tag {
  attributes: Attribute[];
  end: number;
  name: string;
}

function refuse(reason: HtmlRefusal): HtmlCheckResult {
  return { ok: false, reason };
}

// Lowercase ASCII only: the length and every other character stay as they
// are (String.prototype.toLowerCase would fold `İ` into two characters).
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

// The tokenizer's white space, less form feed (refused as a character).
function isSpace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function skipSpace(text: string, index: number): number {
  let at = index;
  while (isSpace(text[at])) {
    at += 1;
  }
  return at;
}

function runEnd(text: string, index: number, pattern: RegExp): number {
  let at = index;
  while (at < text.length && pattern.test(text[at] ?? "")) {
    at += 1;
  }
  return at;
}

// Where a name has to end: white space, `/`, `>` (and `=` after an attribute
// name). A `:` there is a namespaced name; anything else is malformed.
function nameEndRefusal(character: string | undefined, allowEquals: boolean): HtmlRefusal | null {
  if (isSpace(character) || character === "/" || character === ">" || (allowEquals && character === "=")) {
    return null;
  }
  return character === ":" ? "foreign_content" : "malformed";
}

function isAllowedCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint < 0x7f) ||
    (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0x10ffff)
  );
}

// An attribute value with its references resolved exactly once, as the
// tokenizer resolves them, or why it refuses. DEL, C1 controls (which HTML
// re-maps to other characters), surrogates and NUL refuse as references.
function decodeValue(raw: string): string | HtmlRefusal {
  let decoded = "";
  let index = 0;
  for (;;) {
    const ampersand = raw.indexOf("&", index);
    if (ampersand === -1) {
      return decoded + raw.slice(index);
    }
    decoded += raw.slice(index, ampersand);
    if (!REFERENCE_START.test(raw[ampersand + 1] ?? "")) {
      decoded += "&";
      index = ampersand + 1;
      continue;
    }

    const match = REFERENCE.exec(raw.slice(ampersand, ampersand + 12));
    if (match === null) {
      return "entity_reference";
    }
    if (match[3] !== undefined) {
      decoded += NAMED_REFERENCES.get(match[3]) ?? "";
    } else {
      const codePoint =
        match[1] !== undefined ? Number(match[1]) : Number.parseInt(match[2] ?? "", 16);
      if (!isAllowedCodePoint(codePoint)) {
        return "entity_reference";
      }
      decoded += String.fromCodePoint(codePoint);
    }
    index = ampersand + match[0].length;
  }
}

function containsStorageAddress(text: string): boolean {
  const dotted = text.replaceAll("%2e", ".");
  return STORAGE_HOSTS.some((host) => dotted.includes(host));
}

// `javascript:` / `vbscript:` with every white space character removed (a URL
// parser drops tabs and newlines inside a scheme).
function holdsScriptScheme(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.includes("javascript:") || compact.includes("vbscript:");
}

/**
 * Every address in the value: split on white space and commas (a `srcset`,
 * a `ping` list), descriptors skipped. Each must carry an allowed scheme or
 * none; a `:` before the first `/`, `?` or `#` without a scheme the parser
 * would accept is refused as well, whatever the parser would make of it.
 */
function addressRefusal(value: string): HtmlRefusal | null {
  for (const token of value.split(/[\s,]+/)) {
    if (token.length === 0 || SRCSET_DESCRIPTOR.test(token)) {
      continue;
    }
    const scheme = SCHEME.exec(token);
    if (scheme !== null) {
      if (!ALLOWED_SCHEMES.has(scheme[1] ?? "")) {
        return "unsafe_address";
      }
      continue;
    }
    const colon = token.indexOf(":");
    const boundary = token.search(/[/?#]/);
    if (colon !== -1 && (boundary === -1 || colon < boundary)) {
      return "unsafe_address";
    }
  }
  return null;
}

// Every `(` must follow the name of an allowed function (after optional white
// space): `url(`, `url (`, `image-set(`, `expression(` and a bare `(` refuse.
function styleRefusal(value: string): HtmlRefusal | null {
  if (value.includes("\\")) {
    return "escape";
  }
  if (value.includes("@")) {
    return "unsafe_style";
  }
  for (const match of value.matchAll(/([a-z0-9_-]*)\s*\(/g)) {
    if (!STYLE_FUNCTIONS.has(match[1] ?? "")) {
      return "unsafe_style";
    }
  }
  return null;
}

function elementRefusal(name: string): HtmlRefusal | null {
  if (SCRIPT_ELEMENTS.has(name)) {
    return "script";
  }
  if (EMBEDDING_ELEMENTS.has(name)) {
    return "embedded_content";
  }
  if (FOREIGN_ELEMENTS.has(name)) {
    return "foreign_content";
  }
  if (RAW_TEXT_ELEMENTS.has(name)) {
    return "raw_text_element";
  }
  if (FORM_ELEMENTS.has(name)) {
    return "form";
  }
  return DOCUMENT_ELEMENTS.has(name) ? "document_element" : null;
}

function attributeRefusal(attribute: Attribute): HtmlRefusal | null {
  const { name } = attribute;
  if (name.startsWith("on")) {
    return "event_attribute";
  }
  if (name === "srcdoc") {
    return "embedded_content";
  }
  if (FORM_ATTRIBUTES.has(name)) {
    return "form";
  }

  const value = decodeValue(attribute.value);
  // A reference that names a character the scan refuses in raw text.
  if (value === "entity_reference" || INVALID_CHARACTER.test(value)) {
    return "entity_reference";
  }
  // Resolved references are re-checked: `&#106;avascript:`, `&#x3a;`.
  if (holdsScriptScheme(value)) {
    return "javascript_url";
  }
  if (containsStorageAddress(value)) {
    return "storage_address";
  }
  if (name === "style") {
    return styleRefusal(value);
  }
  return ADDRESS_ATTRIBUTES.has(name) ? addressRefusal(value) : null;
}

/**
 * A start tag at `start` (text[start] is `<`, text[start + 1] a letter), read
 * as the tokenizer reads one in its data state, or why it refuses.
 */
function readStartTag(text: string, start: number): Tag | HtmlRefusal {
  let index = runEnd(text, start + 1, TAG_NAME_CHARACTER);
  const name = text.slice(start + 1, index);
  const nameProblem = nameEndRefusal(text[index], false);
  if (nameProblem !== null) {
    return nameProblem;
  }
  // A refused element refuses whatever follows its name.
  const elementProblem = elementRefusal(name);
  if (elementProblem !== null) {
    return elementProblem;
  }

  const attributes: Attribute[] = [];
  const seen = new Set<string>();
  for (;;) {
    index = skipSpace(text, index);
    const character = text[index];
    if (character === ">") {
      return { attributes, end: index + 1, name };
    }
    if (character === "/") {
      return text[index + 1] === ">" ? { attributes, end: index + 2, name } : "malformed";
    }
    if (character === undefined || !LETTER.test(character)) {
      return "malformed";
    }

    const nameStart = index;
    index = runEnd(text, index, ATTRIBUTE_NAME_CHARACTER);
    const attributeName = text.slice(nameStart, index);
    const attributeProblem = nameEndRefusal(text[index], true);
    if (attributeProblem !== null) {
      return attributeProblem;
    }
    if (seen.has(attributeName)) {
      return "malformed";
    }
    seen.add(attributeName);

    const equals = skipSpace(text, index);
    if (text[equals] !== "=") {
      // A name with no value; the next round reads what follows.
      attributes.push({ name: attributeName, value: "" });
      continue;
    }

    index = skipSpace(text, equals + 1);
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, index + 1);
      if (close === -1) {
        return "malformed";
      }
      const value = text.slice(index + 1, close);
      if (value.includes("<")) {
        return "malformed";
      }
      attributes.push({ name: attributeName, value });
      index = close + 1;
      const after = text[index];
      if (!isSpace(after) && after !== "/" && after !== ">") {
        return "malformed";
      }
      continue;
    }

    // Unquoted: up to white space or `>`, as the tokenizer reads it (a `/`
    // belongs to the value there).
    const valueStart = index;
    while (index < text.length && !isSpace(text[index]) && text[index] !== ">") {
      index += 1;
    }
    const value = text.slice(valueStart, index);
    if (value.length === 0 || UNQUOTED_VALUE_REFUSED.test(value)) {
      return "malformed";
    }
    attributes.push({ name: attributeName, value });
  }
}

/** An end tag at `start` (`</name>`, white space before `>` allowed), or why it refuses. */
function readEndTag(text: string, start: number): { end: number; name: string } | HtmlRefusal {
  if (!LETTER.test(text[start + 2] ?? "")) {
    return "malformed";
  }
  const nameEnd = runEnd(text, start + 2, TAG_NAME_CHARACTER);
  const name = text.slice(start + 2, nameEnd);
  if (text[nameEnd] === ":") {
    return "foreign_content";
  }
  const close = skipSpace(text, nameEnd);
  return text[close] === ">" ? { end: close + 1, name } : "malformed";
}

// Every `<` of the text, in order.
function scanMarkup(text: string): HtmlRefusal | null {
  let index = text.indexOf("<");

  while (index !== -1) {
    let resume = index + 1;
    const next = text[index + 1];

    if (text.startsWith("<!--", index)) {
      // Not skipped: the content is scanned like everything else. An
      // unterminated comment would swallow the rest of the page.
      if (text.indexOf("-->", index + 4) === -1) {
        return "malformed";
      }
      resume = index + 4;
    } else if (next === "!") {
      // DOCTYPE, CDATA, and every bogus comment: none has a place in a page.
      return "declaration";
    } else if (next === "?") {
      return "processing_instruction";
    } else if (next === "/") {
      const tag = readEndTag(text, index);
      if (typeof tag === "string") {
        return tag;
      }
      const refusal = elementRefusal(tag.name);
      if (refusal !== null) {
        return refusal;
      }
      resume = tag.end;
    } else if (next !== undefined && LETTER.test(next)) {
      const tag = readStartTag(text, index);
      if (typeof tag === "string") {
        return tag;
      }
      for (const attribute of tag.attributes) {
        const problem = attributeRefusal(attribute);
        if (problem !== null) {
          return problem;
        }
      }
      resume = tag.end;
    } else {
      // A raw `<` in text: an editor writes `&lt;`.
      return "malformed";
    }

    index = text.indexOf("<", resume);
  }

  return null;
}

/**
 * Admits a page's HTML as it is, or refuses it with one reason. Never
 * repairs. Pure: a string in, a verdict out.
 */
export function checkHtml(html: string): HtmlCheckResult {
  if (html.length > HTML_MAX_LENGTH) {
    return refuse("too_large");
  }
  if (INVALID_CHARACTER.test(html) || LONE_SURROGATE.test(html)) {
    return refuse("invalid_character");
  }

  const text = asciiLowerCase(html);
  if (holdsScriptScheme(text)) {
    return refuse("javascript_url");
  }
  if (containsStorageAddress(text)) {
    return refuse("storage_address");
  }

  const problem = scanMarkup(text);
  return problem === null ? { ok: true } : refuse(problem);
}
