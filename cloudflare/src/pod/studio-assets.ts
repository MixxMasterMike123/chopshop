import type { PlatformPrincipal } from "../auth/live-authorization";
import { publicObjectBase } from "../storage/public-objects";
import type { PrintSlot } from "./printers";
import { isPrintSlot, PRINT_SLOTS } from "./printers";
import type { StudioFile, StudioFileRow } from "./studio-files";
import {
  isStudioFileId,
  readActiveStudioFiles,
  studioFileUrl,
  toStudioFile,
} from "./studio-files";

/**
 * The design studio's platform-owned assets (CP5-WH, D101; tables in 0049):
 * the garment MOCKUP TEMPLATES and the 3D-view MODELS. Firebase kept them in
 * `settings/podMockupTemplates` and the `pod3dModels` collection
 * (src/config/podMockupTemplates.js, src/config/pod3dModels.js).
 *
 * THREE SHAPES, deliberately different:
 *
 *   input     what the platform PUTs (parseMockupTemplateInput /
 *             parseModel3dInput): files named by studio-file id, never by
 *             address. Strict: an unknown key refuses the body.
 *   platform  the input as stored, plus its times, and in a list the files
 *             it names (address, size, type) — GET then PUT round-trips.
 *   seller    the Firebase document's own shape, so the studio's code reads
 *             it unchanged (TemplateBackground.jsx, Studio3DSection.jsx,
 *             displacement3dConfig.js): addresses built at read time from
 *             PUBLIC_OBJECT_BASE_URL, ACTIVE assets only, and built FIELD BY
 *             FIELD (an allowlist): no file id, no flag, no sort key, no
 *             operator hint, no time. No money exists on these rows at all.
 *
 * A template is tied to a GARMENT, in the printers' vocabulary
 * (src/pod/printers.ts PrinterModel.garment), and its areas to PRINT_SLOTS:
 * the studio offers a template only when a usable printer makes its garment
 * (GET /v1/admin/pod/printers → `garments`) and reshapes its areas to that
 * printer's frames (src/config/printerAreas.js applyPrinterAreas). No printer
 * id or model key is stored: which printer makes a garment is the routing's
 * business, and a template serves every printer that makes it.
 */

export type Blend = "add" | "multiply" | "normal" | "overlay" | "screen";
const BLENDS: readonly Blend[] = ["add", "multiply", "normal", "overlay", "screen"];

export interface Rect {
  h: number;
  w: number;
  x: number;
  y: number;
}

export interface Size {
  h: number;
  w: number;
}

/** A colourway's override of the warp tuning (Firebase `perColorway[id]`). */
export interface TuningOverride {
  alpha?: number;
  blend?: Blend;
  displacementBlur?: number;
  displacementContrast?: number;
  displacementScale?: number;
}

export type PocketPosition = "center" | "left" | "right";
const POCKET_POSITIONS: readonly PocketPosition[] = ["center", "left", "right"];

export interface TemplateColorwayInput {
  backFileId: string | null;
  frontFileId: string | null;
  hex: string;
  id: string;
  label: string;
  tuning?: TuningOverride;
}

export interface TemplateDisplacementInput {
  alpha?: number;
  backFileId: string | null;
  blend?: Blend;
  blur?: number;
  contrast?: number;
  frontFileId: string | null;
  h: number;
  scale?: number;
  w: number;
}

export interface MockupTemplateInput {
  active: boolean;
  colorways: TemplateColorwayInput[];
  garment: string;
  label: string;
  photo: { displacement: TemplateDisplacementInput | null; h: number; w: number } | null;
  pocketPositions?: Partial<Record<PocketPosition, { x: number }>>;
  printAreaMm: Partial<Record<PrintSlot, Size>>;
  printAreas: Partial<Record<PrintSlot, Rect>>;
  printOffsetTopMm?: Partial<Record<PrintSlot, number>>;
  profileId: string;
  provisional: boolean;
  slotLabels?: Partial<Record<PrintSlot, string>>;
  sortOrder: number;
}

export type ModelView = "back" | "front";
const MODEL_VIEWS: readonly ModelView[] = ["front", "back"];

export interface ModelColorwayInput {
  displacementFileId: string;
  id: string;
  label: string;
  mapContrastSd?: number;
  maskFileId: string | null;
  photoFileId: string;
}

export interface ModelViewInput {
  colorways: ModelColorwayInput[];
  h: number | null;
  originalDims: Size | null;
  printArea: Rect;
  printAreaMm: Size | null;
  w: number | null;
}

export interface Model3dInput {
  active: boolean;
  alpha?: number;
  blend?: Blend;
  displacementBlur?: number;
  displacementContrast?: number;
  displacementScale?: number;
  label: string;
  output: Size | null;
  perColorway: Record<string, TuningOverride>;
  views: Partial<Record<ModelView, ModelViewInput>>;
}

export type ParseResult<T> = { input: T; status: "ok" } | { reason?: string; status: "invalid" };

export const MAX_TEMPLATES = 100;
export const MAX_MODELS = 100;
export const MAX_COLORWAYS = 40;
const MAX_PER_COLORWAY = 100;
const PX_MAX = 20_000;
const MM_MAX = 2_000;
const ORIGINAL_PX_MAX = 100_000;
const SORT_ORDER_MAX = 100_000;
const LABEL_MAX_LENGTH = 80;
const SLOT_LABEL_MAX_LENGTH = 40;
// The studio's own tripwire (podMockupTemplates.js warnOnAspectMismatch): a px
// rect and its mm size must describe the same region, or every preview skews.
const ASPECT_TOLERANCE = 0.01;

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLORWAY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GARMENT_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

// ── parsing ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isLabel(value: unknown, max = LABEL_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max && value === value.trim();
}

function isBlend(value: unknown): value is Blend {
  return typeof value === "string" && (BLENDS as readonly string[]).includes(value);
}

export function isTemplateId(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value);
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

function isColorwayId(value: unknown): value is string {
  return typeof value === "string" && COLORWAY_ID_PATTERN.test(value);
}

function optionalFileId(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return isStudioFileId(value) ? value : undefined;
}

function parseRect(value: unknown, minSide: number): Rect | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["h", "w", "x", "y"])) {
    return null;
  }
  const { h, w, x, y } = value;
  return intIn(x, 0, PX_MAX) && intIn(y, 0, PX_MAX) && intIn(w, minSide, PX_MAX) && intIn(h, minSide, PX_MAX)
    ? { h, w, x, y }
    : null;
}

function parseSize(value: unknown, min: number, max: number): Size | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["h", "w"])) {
    return null;
  }
  const { h, w } = value;
  return intIn(w, min, max) && intIn(h, min, max) ? { h, w } : null;
}

/** An override object; undefined for a malformed one. Empty → {} (the caller drops it). */
function parseTuning(value: unknown): TuningOverride | undefined {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["alpha", "blend", "displacementBlur", "displacementContrast", "displacementScale"])
  ) {
    return undefined;
  }
  const tuning: TuningOverride = {};
  if (value.alpha !== undefined) {
    if (!numberIn(value.alpha, 0, 1)) return undefined;
    tuning.alpha = value.alpha;
  }
  if (value.blend !== undefined) {
    if (!isBlend(value.blend)) return undefined;
    tuning.blend = value.blend;
  }
  if (value.displacementBlur !== undefined) {
    if (!numberIn(value.displacementBlur, 0, 100)) return undefined;
    tuning.displacementBlur = value.displacementBlur;
  }
  if (value.displacementContrast !== undefined) {
    if (!numberIn(value.displacementContrast, 0, 20)) return undefined;
    tuning.displacementContrast = value.displacementContrast;
  }
  if (value.displacementScale !== undefined) {
    if (!numberIn(value.displacementScale, 0, 1000)) return undefined;
    tuning.displacementScale = value.displacementScale;
  }
  return tuning;
}

function isEmpty(value: object): boolean {
  return Object.keys(value).length === 0;
}

/** A map keyed by print slot; undefined when absent, null when malformed. */
function parseSlotMap<T>(
  value: unknown,
  parseEntry: (entry: unknown) => T | null,
): Partial<Record<PrintSlot, T>> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const out: Partial<Record<PrintSlot, T>> = {};
  for (const [slot, entry] of Object.entries(value)) {
    if (!isPrintSlot(slot)) {
      return null;
    }
    const parsed = parseEntry(entry);
    if (parsed === null) {
      return null;
    }
    out[slot] = parsed;
  }
  return out;
}

function slotsOf(map: Partial<Record<PrintSlot, unknown>>): PrintSlot[] {
  return PRINT_SLOTS.filter((slot) => map[slot] !== undefined);
}

const TEMPLATE_KEYS = [
  "active",
  "colorways",
  "garment",
  "label",
  "photo",
  "pocketPositions",
  "printAreaMm",
  "printAreas",
  "printOffsetTopMm",
  "profileId",
  "provisional",
  "slotLabels",
  "sortOrder",
] as const;

function parseTemplateColorway(value: unknown): TemplateColorwayInput | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["backFileId", "frontFileId", "hex", "id", "label", "tuning"]) ||
    !isColorwayId(value.id) ||
    !isLabel(value.label) ||
    typeof value.hex !== "string" ||
    !HEX_PATTERN.test(value.hex)
  ) {
    return null;
  }
  const frontFileId = value.frontFileId === undefined ? null : optionalFileId(value.frontFileId);
  const backFileId = value.backFileId === undefined ? null : optionalFileId(value.backFileId);
  if (frontFileId === undefined || backFileId === undefined) {
    return null;
  }
  const colorway: TemplateColorwayInput = {
    backFileId,
    frontFileId,
    hex: value.hex,
    id: value.id,
    label: value.label,
  };
  if (value.tuning !== undefined) {
    const tuning = parseTuning(value.tuning);
    if (tuning === undefined) {
      return null;
    }
    if (!isEmpty(tuning)) {
      colorway.tuning = tuning;
    }
  }
  return colorway;
}

function parseDisplacement(value: unknown): TemplateDisplacementInput | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["alpha", "backFileId", "blend", "blur", "contrast", "frontFileId", "h", "scale", "w"]) ||
    !intIn(value.w, 1, PX_MAX) ||
    !intIn(value.h, 1, PX_MAX)
  ) {
    return undefined;
  }
  const frontFileId = value.frontFileId === undefined ? null : optionalFileId(value.frontFileId);
  const backFileId = value.backFileId === undefined ? null : optionalFileId(value.backFileId);
  if (frontFileId === undefined || backFileId === undefined || (frontFileId === null && backFileId === null)) {
    return undefined;
  }
  const out: TemplateDisplacementInput = { backFileId, frontFileId, h: value.h, w: value.w };
  if (value.scale !== undefined) {
    if (!numberIn(value.scale, 0, 1000)) return undefined;
    out.scale = value.scale;
  }
  if (value.blur !== undefined) {
    if (!numberIn(value.blur, 0, 100)) return undefined;
    out.blur = value.blur;
  }
  if (value.contrast !== undefined) {
    if (!numberIn(value.contrast, 0, 20)) return undefined;
    out.contrast = value.contrast;
  }
  if (value.blend !== undefined) {
    if (!isBlend(value.blend)) return undefined;
    out.blend = value.blend;
  }
  if (value.alpha !== undefined) {
    if (!numberIn(value.alpha, 0, 1)) return undefined;
    out.alpha = value.alpha;
  }
  return out;
}

/**
 * PUT /v1/platform/pod/mockup-templates/:templateId's body. Shape errors
 * answer `invalid` without a reason; a body that is well-formed but cannot be
 * a calibrated template answers a reason the platform can act on:
 *
 *   aspect_mismatch            a slot's px rect and mm size differ in aspect by
 *                              more than 1 % (POD_PRINT_SPEC: they MUST agree)
 *   area_outside_photo         a px rect leaves a photo template's photo
 *   files_on_flat_template     a flat template names a photo file
 *   tuning_without_displacement  a colourway overrides a warp that does not exist
 *   pocket_positions_without_pocket
 *   duplicate_colorway
 */
export function parseMockupTemplateInput(body: unknown): ParseResult<MockupTemplateInput> {
  const invalid = (reason?: string): ParseResult<MockupTemplateInput> =>
    reason === undefined ? { status: "invalid" } : { reason, status: "invalid" };
  if (!isPlainObject(body) || !hasOnlyKeys(body, TEMPLATE_KEYS)) {
    return invalid();
  }
  if (
    !isLabel(body.label) ||
    typeof body.garment !== "string" ||
    !GARMENT_PATTERN.test(body.garment) ||
    typeof body.profileId !== "string" ||
    !PROFILE_ID_PATTERN.test(body.profileId)
  ) {
    return invalid();
  }
  const active = body.active === undefined ? true : body.active;
  const provisional = body.provisional === undefined ? false : body.provisional;
  const sortOrder = body.sortOrder === undefined ? 0 : body.sortOrder;
  if (typeof active !== "boolean" || typeof provisional !== "boolean" || !intIn(sortOrder, 0, SORT_ORDER_MAX)) {
    return invalid();
  }

  const printAreas = parseSlotMap(body.printAreas, (entry) => parseRect(entry, 1));
  const printAreaMm = parseSlotMap(body.printAreaMm, (entry) => parseSize(entry, 1, MM_MAX));
  const printOffsetTopMm = parseSlotMap(body.printOffsetTopMm, (entry) =>
    intIn(entry, 0, MM_MAX) ? entry : null,
  );
  const slotLabels = parseSlotMap(body.slotLabels, (entry) =>
    isLabel(entry, SLOT_LABEL_MAX_LENGTH) ? entry : null,
  );
  if (
    !printAreas ||
    !printAreaMm ||
    printOffsetTopMm === null ||
    slotLabels === null ||
    isEmpty(printAreas)
  ) {
    return invalid();
  }
  const areaSlots = slotsOf(printAreas);
  // The px rect and the mm size describe the same region: one each, per slot.
  if (slotsOf(printAreaMm).join() !== areaSlots.join()) {
    return invalid();
  }
  for (const map of [printOffsetTopMm, slotLabels]) {
    if (map !== undefined && !slotsOf(map).every((slot) => printAreas[slot] !== undefined)) {
      return invalid();
    }
  }

  let pocketPositions: Partial<Record<PocketPosition, { x: number }>> | undefined;
  if (body.pocketPositions !== undefined) {
    if (!isPlainObject(body.pocketPositions)) {
      return invalid();
    }
    pocketPositions = {};
    for (const [position, entry] of Object.entries(body.pocketPositions)) {
      if (
        !(POCKET_POSITIONS as readonly string[]).includes(position) ||
        !isPlainObject(entry) ||
        !hasOnlyKeys(entry, ["x"]) ||
        !intIn(entry.x, 0, PX_MAX)
      ) {
        return invalid();
      }
      pocketPositions[position as PocketPosition] = { x: entry.x };
    }
    if (isEmpty(pocketPositions)) {
      pocketPositions = undefined;
    } else if (printAreas.pocket === undefined) {
      return invalid("pocket_positions_without_pocket");
    }
  }

  let photo: MockupTemplateInput["photo"] = null;
  if (body.photo !== undefined && body.photo !== null) {
    const raw = body.photo;
    if (
      !isPlainObject(raw) ||
      !hasOnlyKeys(raw, ["displacement", "h", "w"]) ||
      !intIn(raw.w, 1, PX_MAX) ||
      !intIn(raw.h, 1, PX_MAX)
    ) {
      return invalid();
    }
    const displacement = parseDisplacement(raw.displacement);
    if (displacement === undefined) {
      return invalid();
    }
    photo = { displacement, h: raw.h, w: raw.w };
  }

  if (!Array.isArray(body.colorways) || body.colorways.length < 1 || body.colorways.length > MAX_COLORWAYS) {
    return invalid();
  }
  const colorways: TemplateColorwayInput[] = [];
  for (const entry of body.colorways) {
    const colorway = parseTemplateColorway(entry);
    if (colorway === null) {
      return invalid();
    }
    if (colorways.some((other) => other.id === colorway.id)) {
      return invalid("duplicate_colorway");
    }
    colorways.push(colorway);
  }

  if (photo === null && colorways.some((c) => c.frontFileId !== null || c.backFileId !== null)) {
    return invalid("files_on_flat_template");
  }
  if ((photo === null || photo.displacement === null) && colorways.some((c) => c.tuning !== undefined)) {
    return invalid("tuning_without_displacement");
  }

  for (const slot of areaSlots) {
    const rect = printAreas[slot] as Rect;
    const mm = printAreaMm[slot] as Size;
    const drift = Math.abs(rect.w / rect.h / (mm.w / mm.h) - 1);
    if (drift > ASPECT_TOLERANCE) {
      return invalid("aspect_mismatch");
    }
    if (photo !== null && (rect.x + rect.w > photo.w || rect.y + rect.h > photo.h)) {
      return invalid("area_outside_photo");
    }
  }
  if (photo !== null && pocketPositions !== undefined && printAreas.pocket !== undefined) {
    const pocketWidth = printAreas.pocket.w;
    if (Object.values(pocketPositions).some((p) => p.x + pocketWidth > photo.w)) {
      return invalid("area_outside_photo");
    }
  }

  const input: MockupTemplateInput = {
    active,
    colorways,
    garment: body.garment,
    label: body.label,
    photo,
    printAreaMm,
    printAreas,
    profileId: body.profileId,
    provisional,
    sortOrder,
  };
  if (pocketPositions !== undefined) input.pocketPositions = pocketPositions;
  if (printOffsetTopMm !== undefined && !isEmpty(printOffsetTopMm)) input.printOffsetTopMm = printOffsetTopMm;
  if (slotLabels !== undefined && !isEmpty(slotLabels)) input.slotLabels = slotLabels;
  return { input, status: "ok" };
}

const MODEL_KEYS = [
  "active",
  "alpha",
  "blend",
  "displacementBlur",
  "displacementContrast",
  "displacementScale",
  "label",
  "output",
  "perColorway",
  "views",
] as const;

function parseModelColorway(value: unknown): ModelColorwayInput | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["displacementFileId", "id", "label", "mapContrastSd", "maskFileId", "photoFileId"]) ||
    !isColorwayId(value.id) ||
    !isLabel(value.label) ||
    !isStudioFileId(value.photoFileId) ||
    !isStudioFileId(value.displacementFileId)
  ) {
    return null;
  }
  const maskFileId = value.maskFileId === undefined ? null : optionalFileId(value.maskFileId);
  if (maskFileId === undefined) {
    return null;
  }
  const colorway: ModelColorwayInput = {
    displacementFileId: value.displacementFileId,
    id: value.id,
    label: value.label,
    maskFileId,
    photoFileId: value.photoFileId,
  };
  if (value.mapContrastSd !== undefined && value.mapContrastSd !== null) {
    if (!numberIn(value.mapContrastSd, 0, 256)) {
      return null;
    }
    colorway.mapContrastSd = value.mapContrastSd;
  }
  return colorway;
}

function parseModelView(value: unknown): ModelViewInput | null | "duplicate_colorway" {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["colorways", "h", "originalDims", "printArea", "printAreaMm", "w"])
  ) {
    return null;
  }
  const w = value.w === undefined ? null : value.w;
  const h = value.h === undefined ? null : value.h;
  if ((w === null) !== (h === null) || (w !== null && (!intIn(w, 1, PX_MAX) || !intIn(h, 1, PX_MAX)))) {
    return null;
  }
  const printArea = parseRect(value.printArea, 0);
  const printAreaMm =
    value.printAreaMm === undefined || value.printAreaMm === null ? null : parseSize(value.printAreaMm, 0, MM_MAX);
  const originalDims =
    value.originalDims === undefined || value.originalDims === null
      ? null
      : parseSize(value.originalDims, 1, ORIGINAL_PX_MAX);
  if (
    printArea === null ||
    (value.printAreaMm != null && printAreaMm === null) ||
    (value.originalDims != null && originalDims === null)
  ) {
    return null;
  }
  const rawColorways = value.colorways === undefined ? [] : value.colorways;
  if (!Array.isArray(rawColorways) || rawColorways.length > MAX_COLORWAYS) {
    return null;
  }
  const colorways: ModelColorwayInput[] = [];
  for (const entry of rawColorways) {
    const colorway = parseModelColorway(entry);
    if (colorway === null) {
      return null;
    }
    if (colorways.some((other) => other.id === colorway.id)) {
      return "duplicate_colorway";
    }
    colorways.push(colorway);
  }
  return { colorways, h: h as number | null, originalDims, printArea, printAreaMm, w: w as number | null };
}

/** PUT /v1/platform/pod/3d-models/:modelId's body (reasons: duplicate_colorway). */
export function parseModel3dInput(body: unknown): ParseResult<Model3dInput> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, MODEL_KEYS) || !isLabel(body.label)) {
    return { status: "invalid" };
  }
  const active = body.active === undefined ? true : body.active;
  if (typeof active !== "boolean") {
    return { status: "invalid" };
  }
  const input: Model3dInput = {
    active,
    label: body.label,
    output: null,
    perColorway: {},
    views: {},
  };
  const tuning = parseTuning({
    ...(body.alpha === undefined ? {} : { alpha: body.alpha }),
    ...(body.blend === undefined ? {} : { blend: body.blend }),
    ...(body.displacementBlur === undefined ? {} : { displacementBlur: body.displacementBlur }),
    ...(body.displacementContrast === undefined ? {} : { displacementContrast: body.displacementContrast }),
    ...(body.displacementScale === undefined ? {} : { displacementScale: body.displacementScale }),
  });
  if (tuning === undefined) {
    return { status: "invalid" };
  }
  Object.assign(input, tuning);

  if (body.output !== undefined && body.output !== null) {
    const output = parseSize(body.output, 1, PX_MAX);
    if (output === null) {
      return { status: "invalid" };
    }
    input.output = output;
  }

  if (body.perColorway !== undefined) {
    if (!isPlainObject(body.perColorway) || Object.keys(body.perColorway).length > MAX_PER_COLORWAY) {
      return { status: "invalid" };
    }
    for (const [colorwayId, entry] of Object.entries(body.perColorway)) {
      const override = isColorwayId(colorwayId) ? parseTuning(entry) : undefined;
      if (override === undefined) {
        return { status: "invalid" };
      }
      if (!isEmpty(override)) {
        input.perColorway[colorwayId] = override;
      }
    }
  }

  if (!isPlainObject(body.views) || isEmpty(body.views)) {
    return { status: "invalid" };
  }
  for (const [viewId, entry] of Object.entries(body.views)) {
    if (!(MODEL_VIEWS as readonly string[]).includes(viewId)) {
      return { status: "invalid" };
    }
    const view = parseModelView(entry);
    if (view === null) {
      return { status: "invalid" };
    }
    if (view === "duplicate_colorway") {
      return { reason: "duplicate_colorway", status: "invalid" };
    }
    input.views[viewId as ModelView] = view;
  }
  return { input, status: "ok" };
}

/** Every file id an input names (for the "exists and is active" check). */
export function templateFileIds(input: MockupTemplateInput): string[] {
  const ids: string[] = [];
  for (const colorway of input.colorways) {
    if (colorway.frontFileId !== null) ids.push(colorway.frontFileId);
    if (colorway.backFileId !== null) ids.push(colorway.backFileId);
  }
  const displacement = input.photo?.displacement;
  if (displacement) {
    if (displacement.frontFileId !== null) ids.push(displacement.frontFileId);
    if (displacement.backFileId !== null) ids.push(displacement.backFileId);
  }
  return [...new Set(ids)];
}

export function modelFileIds(input: Model3dInput): string[] {
  const ids: string[] = [];
  for (const view of MODEL_VIEWS) {
    for (const colorway of input.views[view]?.colorways ?? []) {
      ids.push(colorway.photoFileId, colorway.displacementFileId);
      if (colorway.maskFileId !== null) ids.push(colorway.maskFileId);
    }
  }
  return [...new Set(ids)];
}

/**
 * A 3D colourway's photo, map and mask are one registered set: when their
 * pixel sizes are known they must be equal (src/utils/pod3dUpload.js
 * validateModelAssetSet). Answers false on a known mismatch.
 */
function modelFilesRegistered(input: Model3dInput, files: Map<string, StudioFileRow>): boolean {
  for (const view of MODEL_VIEWS) {
    for (const colorway of input.views[view]?.colorways ?? []) {
      const sizes = [colorway.photoFileId, colorway.displacementFileId, colorway.maskFileId]
        .filter((id): id is string => id !== null)
        .map((id) => files.get(id))
        .filter((row): row is StudioFileRow => row !== undefined && row.width_px !== null && row.height_px !== null)
        .map((row) => `${row.width_px}x${row.height_px}`);
      if (new Set(sizes).size > 1) {
        return false;
      }
    }
  }
  return true;
}

// ── rows ────────────────────────────────────────────────────────────────────

function iso(now: number): string {
  return new Date(now).toISOString();
}

/** JSON with object keys sorted, for "is this the same document" checks. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface TemplateRow {
  active: number;
  created_at: string;
  garment: string;
  label: string;
  map_alpha: number | null;
  map_back_file_id: string | null;
  map_blend: string | null;
  map_blur: number | null;
  map_contrast: number | null;
  map_front_file_id: string | null;
  map_h_px: number | null;
  map_scale: number | null;
  map_w_px: number | null;
  photo_h_px: number | null;
  photo_w_px: number | null;
  pocket_center_x_px: number | null;
  pocket_left_x_px: number | null;
  pocket_right_x_px: number | null;
  profile_id: string;
  provisional: number;
  sort_order: number;
  template_id: string;
  updated_at: string;
}

interface AreaRow {
  h_mm: number;
  h_px: number;
  offset_top_mm: number | null;
  slot: string;
  slot_label: string | null;
  template_id: string;
  w_mm: number;
  w_px: number;
  x_px: number;
  y_px: number;
}

interface TemplateColorwayRow {
  alpha: number | null;
  back_file_id: string | null;
  blend: string | null;
  colorway_id: string;
  displacement_blur: number | null;
  displacement_contrast: number | null;
  displacement_scale: number | null;
  front_file_id: string | null;
  hex: string;
  label: string;
  template_id: string;
}

interface ModelRow {
  active: number;
  alpha: number | null;
  blend: string | null;
  created_at: string;
  displacement_blur: number | null;
  displacement_contrast: number | null;
  displacement_scale: number | null;
  label: string;
  model_id: string;
  output_h_px: number | null;
  output_w_px: number | null;
  per_colorway_json: string;
  updated_at: string;
}

interface ModelViewRow {
  h_px: number | null;
  model_id: string;
  original_h_px: number | null;
  original_w_px: number | null;
  print_h_mm: number | null;
  print_h_px: number;
  print_w_mm: number | null;
  print_w_px: number;
  print_x_px: number;
  print_y_px: number;
  view_id: string;
  w_px: number | null;
}

interface ModelColorwayRow {
  colorway_id: string;
  displacement_file_id: string;
  label: string;
  map_contrast_sd: number | null;
  mask_file_id: string | null;
  model_id: string;
  photo_file_id: string;
  view_id: string;
}

export interface StoredTemplate {
  createdAt: string;
  input: MockupTemplateInput;
  templateId: string;
  updatedAt: string;
}

export interface StoredModel {
  createdAt: string;
  input: Model3dInput;
  modelId: string;
  updatedAt: string;
}

function tuningOf(row: {
  alpha: number | null;
  blend: string | null;
  displacement_blur: number | null;
  displacement_contrast: number | null;
  displacement_scale: number | null;
}): TuningOverride {
  const tuning: TuningOverride = {};
  if (row.alpha !== null) tuning.alpha = row.alpha;
  if (row.blend !== null) tuning.blend = row.blend as Blend;
  if (row.displacement_blur !== null) tuning.displacementBlur = row.displacement_blur;
  if (row.displacement_contrast !== null) tuning.displacementContrast = row.displacement_contrast;
  if (row.displacement_scale !== null) tuning.displacementScale = row.displacement_scale;
  return tuning;
}

function templateFromRows(row: TemplateRow, areas: AreaRow[], colorways: TemplateColorwayRow[]): StoredTemplate {
  const printAreas: Partial<Record<PrintSlot, Rect>> = {};
  const printAreaMm: Partial<Record<PrintSlot, Size>> = {};
  const printOffsetTopMm: Partial<Record<PrintSlot, number>> = {};
  const slotLabels: Partial<Record<PrintSlot, string>> = {};
  for (const slot of PRINT_SLOTS) {
    const area = areas.find((entry) => entry.slot === slot);
    if (area === undefined) continue;
    printAreas[slot] = { h: area.h_px, w: area.w_px, x: area.x_px, y: area.y_px };
    printAreaMm[slot] = { h: area.h_mm, w: area.w_mm };
    if (area.offset_top_mm !== null) printOffsetTopMm[slot] = area.offset_top_mm;
    if (area.slot_label !== null) slotLabels[slot] = area.slot_label;
  }
  let photo: MockupTemplateInput["photo"] = null;
  if (row.photo_w_px !== null && row.photo_h_px !== null) {
    let displacement: TemplateDisplacementInput | null = null;
    if (row.map_w_px !== null && row.map_h_px !== null) {
      displacement = {
        backFileId: row.map_back_file_id,
        frontFileId: row.map_front_file_id,
        h: row.map_h_px,
        w: row.map_w_px,
      };
      if (row.map_scale !== null) displacement.scale = row.map_scale;
      if (row.map_blur !== null) displacement.blur = row.map_blur;
      if (row.map_contrast !== null) displacement.contrast = row.map_contrast;
      if (row.map_blend !== null) displacement.blend = row.map_blend as Blend;
      if (row.map_alpha !== null) displacement.alpha = row.map_alpha;
    }
    photo = { displacement, h: row.photo_h_px, w: row.photo_w_px };
  }
  const input: MockupTemplateInput = {
    active: row.active === 1,
    colorways: colorways.map((entry) => {
      const colorway: TemplateColorwayInput = {
        backFileId: entry.back_file_id,
        frontFileId: entry.front_file_id,
        hex: entry.hex,
        id: entry.colorway_id,
        label: entry.label,
      };
      const tuning = tuningOf(entry);
      if (!isEmpty(tuning)) colorway.tuning = tuning;
      return colorway;
    }),
    garment: row.garment,
    label: row.label,
    photo,
    printAreaMm,
    printAreas,
    profileId: row.profile_id,
    provisional: row.provisional === 1,
    sortOrder: row.sort_order,
  };
  const pocket: Partial<Record<PocketPosition, { x: number }>> = {};
  if (row.pocket_left_x_px !== null) pocket.left = { x: row.pocket_left_x_px };
  if (row.pocket_center_x_px !== null) pocket.center = { x: row.pocket_center_x_px };
  if (row.pocket_right_x_px !== null) pocket.right = { x: row.pocket_right_x_px };
  if (!isEmpty(pocket)) input.pocketPositions = pocket;
  if (!isEmpty(printOffsetTopMm)) input.printOffsetTopMm = printOffsetTopMm;
  if (!isEmpty(slotLabels)) input.slotLabels = slotLabels;
  return { createdAt: row.created_at, input, templateId: row.template_id, updatedAt: row.updated_at };
}

function parseStoredPerColorway(json: string): Record<string, TuningOverride> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed)) return {};
    const out: Record<string, TuningOverride> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const tuning = isColorwayId(key) ? parseTuning(value) : undefined;
      if (tuning !== undefined && !isEmpty(tuning)) out[key] = tuning;
    }
    return out;
  } catch {
    return {};
  }
}

function modelFromRows(row: ModelRow, views: ModelViewRow[], colorways: ModelColorwayRow[]): StoredModel {
  const input: Model3dInput = {
    active: row.active === 1,
    label: row.label,
    output:
      row.output_w_px !== null && row.output_h_px !== null ? { h: row.output_h_px, w: row.output_w_px } : null,
    perColorway: parseStoredPerColorway(row.per_colorway_json),
    views: {},
  };
  Object.assign(input, tuningOf(row));
  for (const viewId of MODEL_VIEWS) {
    const view = views.find((entry) => entry.view_id === viewId);
    if (view === undefined) continue;
    input.views[viewId] = {
      colorways: colorways
        .filter((entry) => entry.view_id === viewId)
        .map((entry) => {
          const colorway: ModelColorwayInput = {
            displacementFileId: entry.displacement_file_id,
            id: entry.colorway_id,
            label: entry.label,
            maskFileId: entry.mask_file_id,
            photoFileId: entry.photo_file_id,
          };
          if (entry.map_contrast_sd !== null) colorway.mapContrastSd = entry.map_contrast_sd;
          return colorway;
        }),
      h: view.h_px,
      originalDims:
        view.original_w_px !== null && view.original_h_px !== null
          ? { h: view.original_h_px, w: view.original_w_px }
          : null,
      printArea: { h: view.print_h_px, w: view.print_w_px, x: view.print_x_px, y: view.print_y_px },
      printAreaMm:
        view.print_w_mm !== null && view.print_h_mm !== null ? { h: view.print_h_mm, w: view.print_w_mm } : null,
      w: view.w_px,
    };
  }
  return { createdAt: row.created_at, input, modelId: row.model_id, updatedAt: row.updated_at };
}

// ── reads ───────────────────────────────────────────────────────────────────

const TEMPLATE_COLUMNS = `t.template_id, t.label, t.garment, t.profile_id, t.active, t.provisional,
  t.sort_order, t.photo_w_px, t.photo_h_px, t.map_w_px, t.map_h_px, t.map_front_file_id,
  t.map_back_file_id, t.map_scale, t.map_blur, t.map_contrast, t.map_blend, t.map_alpha,
  t.pocket_left_x_px, t.pocket_center_x_px, t.pocket_right_x_px, t.created_at, t.updated_at`;
const AREA_COLUMNS = `a.template_id, a.slot, a.x_px, a.y_px, a.w_px, a.h_px, a.w_mm, a.h_mm,
  a.offset_top_mm, a.slot_label`;
const TEMPLATE_COLORWAY_COLUMNS = `c.template_id, c.colorway_id, c.label, c.hex, c.front_file_id,
  c.back_file_id, c.blend, c.alpha, c.displacement_scale, c.displacement_blur, c.displacement_contrast`;
const MODEL_COLUMNS = `m.model_id, m.label, m.active, m.displacement_scale, m.displacement_blur,
  m.displacement_contrast, m.blend, m.alpha, m.output_w_px, m.output_h_px, m.per_colorway_json,
  m.created_at, m.updated_at`;
const MODEL_VIEW_COLUMNS = `v.model_id, v.view_id, v.w_px, v.h_px, v.print_x_px, v.print_y_px,
  v.print_w_px, v.print_h_px, v.print_w_mm, v.print_h_mm, v.original_w_px, v.original_h_px`;
const MODEL_COLORWAY_COLUMNS = `c.model_id, c.view_id, c.colorway_id, c.label, c.photo_file_id,
  c.displacement_file_id, c.mask_file_id, c.map_contrast_sd`;

/**
 * The templates (all, or one, or the active ones), in their order. Three
 * statements in one batch, so the parts are one snapshot; bounded by
 * MAX_TEMPLATES, five areas and MAX_COLORWAYS colourways per template.
 */
async function readTemplates(
  db: D1Database,
  filter: { activeOnly: boolean; templateId?: string },
): Promise<StoredTemplate[]> {
  const where = [
    ...(filter.activeOnly ? ["t.active = 1"] : []),
    ...(filter.templateId === undefined ? [] : ["t.template_id = ?1"]),
  ];
  const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const bind = (statement: D1PreparedStatement) =>
    filter.templateId === undefined ? statement : statement.bind(filter.templateId);
  const [templates, areas, colorways] = await db.batch([
    bind(
      db.prepare(
        `SELECT ${TEMPLATE_COLUMNS} FROM pod_mockup_templates AS t ${clause}
         ORDER BY t.sort_order, t.template_id LIMIT ${MAX_TEMPLATES}`,
      ),
    ),
    bind(
      db.prepare(
        `SELECT ${AREA_COLUMNS} FROM pod_mockup_template_areas AS a
         JOIN pod_mockup_templates AS t ON t.template_id = a.template_id ${clause}
         ORDER BY a.template_id, a.slot LIMIT ${MAX_TEMPLATES * PRINT_SLOTS.length}`,
      ),
    ),
    bind(
      db.prepare(
        `SELECT ${TEMPLATE_COLORWAY_COLUMNS} FROM pod_mockup_template_colorways AS c
         JOIN pod_mockup_templates AS t ON t.template_id = c.template_id ${clause}
         ORDER BY c.template_id, c.position LIMIT ${MAX_TEMPLATES * MAX_COLORWAYS}`,
      ),
    ),
  ]);
  const areaRows = (areas?.results ?? []) as AreaRow[];
  const colorwayRows = (colorways?.results ?? []) as TemplateColorwayRow[];
  return ((templates?.results ?? []) as TemplateRow[]).map((row) =>
    templateFromRows(
      row,
      areaRows.filter((area) => area.template_id === row.template_id),
      colorwayRows.filter((colorway) => colorway.template_id === row.template_id),
    ),
  );
}

async function readModels(
  db: D1Database,
  filter: { activeOnly: boolean; modelId?: string },
): Promise<StoredModel[]> {
  const where = [
    ...(filter.activeOnly ? ["m.active = 1"] : []),
    ...(filter.modelId === undefined ? [] : ["m.model_id = ?1"]),
  ];
  const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const bind = (statement: D1PreparedStatement) =>
    filter.modelId === undefined ? statement : statement.bind(filter.modelId);
  const [models, views, colorways] = await db.batch([
    bind(
      db.prepare(
        `SELECT ${MODEL_COLUMNS} FROM pod_3d_models AS m ${clause}
         ORDER BY m.label, m.model_id LIMIT ${MAX_MODELS}`,
      ),
    ),
    bind(
      db.prepare(
        `SELECT ${MODEL_VIEW_COLUMNS} FROM pod_3d_model_views AS v
         JOIN pod_3d_models AS m ON m.model_id = v.model_id ${clause}
         ORDER BY v.model_id, v.view_id LIMIT ${MAX_MODELS * MODEL_VIEWS.length}`,
      ),
    ),
    bind(
      db.prepare(
        `SELECT ${MODEL_COLORWAY_COLUMNS} FROM pod_3d_model_colorways AS c
         JOIN pod_3d_models AS m ON m.model_id = c.model_id ${clause}
         ORDER BY c.model_id, c.view_id, c.position
         LIMIT ${MAX_MODELS * MODEL_VIEWS.length * MAX_COLORWAYS}`,
      ),
    ),
  ]);
  const viewRows = (views?.results ?? []) as ModelViewRow[];
  const colorwayRows = (colorways?.results ?? []) as ModelColorwayRow[];
  return ((models?.results ?? []) as ModelRow[]).map((row) =>
    modelFromRows(
      row,
      viewRows.filter((view) => view.model_id === row.model_id),
      colorwayRows.filter((colorway) => colorway.model_id === row.model_id),
    ),
  );
}

// ── the seller's shapes (allowlist) ─────────────────────────────────────────

export interface SellerTemplate {
  colorways: Array<{ hex: string; id: string; label: string }>;
  garment: string;
  id: string;
  label: string;
  photo?: {
    backUrls: Record<string, string>;
    displacement?: {
      alpha?: number;
      blend?: Blend;
      blur?: number;
      contrast?: number;
      h: number;
      perColorway: Record<string, TuningOverride>;
      scale?: number;
      urls: { back?: string; front?: string };
      w: number;
    };
    h: number;
    urls: Record<string, string>;
    w: number;
  };
  pocketPositions?: Partial<Record<PocketPosition, { x: number }>>;
  printAreaMm: Partial<Record<PrintSlot, Size>>;
  printAreas: Partial<Record<PrintSlot, Rect>>;
  printOffsetTopMm?: Partial<Record<PrintSlot, number>>;
  profileId: string;
  provisional: boolean;
  slotLabels?: Partial<Record<PrintSlot, string>>;
}

export interface SellerModel {
  alpha?: number;
  blend?: Blend;
  displacementBlur?: number;
  displacementContrast?: number;
  displacementScale?: number;
  id: string;
  label: string;
  output: Size | null;
  perColorway: Record<string, TuningOverride>;
  printAreaMm: Partial<Record<ModelView, Size>>;
  views: Partial<
    Record<
      ModelView,
      {
        colorways: Record<string, { displacementUrl?: string; label: string; maskUrl?: string; photoUrl?: string }>;
        h: number | null;
        printArea: Rect;
        w: number | null;
      }
    >
  >;
}

type UrlOf = (fileId: string | null) => string | null;

function urlResolver(files: Map<string, StudioFileRow>, base: string | null): UrlOf {
  return (fileId) => {
    if (fileId === null) return null;
    const row = files.get(fileId);
    return row === undefined ? null : studioFileUrl(base, row.object_key);
  };
}

function copyRect(rect: Rect): Rect {
  return { h: rect.h, w: rect.w, x: rect.x, y: rect.y };
}

function copyTuning(tuning: TuningOverride): TuningOverride {
  const out: TuningOverride = {};
  if (tuning.alpha !== undefined) out.alpha = tuning.alpha;
  if (tuning.blend !== undefined) out.blend = tuning.blend;
  if (tuning.displacementBlur !== undefined) out.displacementBlur = tuning.displacementBlur;
  if (tuning.displacementContrast !== undefined) out.displacementContrast = tuning.displacementContrast;
  if (tuning.displacementScale !== undefined) out.displacementScale = tuning.displacementScale;
  return out;
}

function sellerTemplate(stored: StoredTemplate, urlOf: UrlOf): SellerTemplate {
  const input = stored.input;
  const printAreas: Partial<Record<PrintSlot, Rect>> = {};
  const printAreaMm: Partial<Record<PrintSlot, Size>> = {};
  for (const slot of slotsOf(input.printAreas)) {
    printAreas[slot] = copyRect(input.printAreas[slot] as Rect);
    const mm = input.printAreaMm[slot] as Size;
    printAreaMm[slot] = { h: mm.h, w: mm.w };
  }
  const out: SellerTemplate = {
    colorways: input.colorways.map((colorway) => ({ hex: colorway.hex, id: colorway.id, label: colorway.label })),
    garment: input.garment,
    id: stored.templateId,
    label: input.label,
    printAreaMm,
    printAreas,
    profileId: input.profileId,
    provisional: input.provisional,
  };
  if (input.printOffsetTopMm) out.printOffsetTopMm = { ...input.printOffsetTopMm };
  if (input.slotLabels) out.slotLabels = { ...input.slotLabels };
  if (input.pocketPositions) {
    out.pocketPositions = Object.fromEntries(
      Object.entries(input.pocketPositions).map(([position, entry]) => [position, { x: entry.x }]),
    );
  }
  if (input.photo !== null) {
    const urls: Record<string, string> = {};
    const backUrls: Record<string, string> = {};
    for (const colorway of input.colorways) {
      const front = urlOf(colorway.frontFileId);
      const back = urlOf(colorway.backFileId);
      if (front !== null) urls[colorway.id] = front;
      if (back !== null) backUrls[colorway.id] = back;
    }
    out.photo = { backUrls, h: input.photo.h, urls, w: input.photo.w };
    const map = input.photo.displacement;
    if (map !== null) {
      const mapUrls: { back?: string; front?: string } = {};
      const front = urlOf(map.frontFileId);
      const back = urlOf(map.backFileId);
      if (front !== null) mapUrls.front = front;
      if (back !== null) mapUrls.back = back;
      const perColorway: Record<string, TuningOverride> = {};
      for (const colorway of input.colorways) {
        if (colorway.tuning !== undefined) perColorway[colorway.id] = copyTuning(colorway.tuning);
      }
      out.photo.displacement = { h: map.h, perColorway, urls: mapUrls, w: map.w };
      if (map.scale !== undefined) out.photo.displacement.scale = map.scale;
      if (map.blur !== undefined) out.photo.displacement.blur = map.blur;
      if (map.contrast !== undefined) out.photo.displacement.contrast = map.contrast;
      if (map.blend !== undefined) out.photo.displacement.blend = map.blend;
      if (map.alpha !== undefined) out.photo.displacement.alpha = map.alpha;
    }
  }
  return out;
}

function sellerModel(stored: StoredModel, urlOf: UrlOf): SellerModel {
  const input = stored.input;
  const out: SellerModel = {
    id: stored.modelId,
    label: input.label,
    output: input.output === null ? null : { h: input.output.h, w: input.output.w },
    perColorway: Object.fromEntries(
      Object.entries(input.perColorway).map(([id, tuning]) => [id, copyTuning(tuning)]),
    ),
    printAreaMm: {},
    views: {},
  };
  Object.assign(out, copyTuning(input));
  for (const viewId of MODEL_VIEWS) {
    const view = input.views[viewId];
    if (view === undefined) continue;
    const colorways: Record<string, { displacementUrl?: string; label: string; maskUrl?: string; photoUrl?: string }> =
      {};
    for (const colorway of view.colorways) {
      const entry: { displacementUrl?: string; label: string; maskUrl?: string; photoUrl?: string } = {
        label: colorway.label,
      };
      const photo = urlOf(colorway.photoFileId);
      const map = urlOf(colorway.displacementFileId);
      const mask = urlOf(colorway.maskFileId);
      if (photo !== null) entry.photoUrl = photo;
      if (map !== null) entry.displacementUrl = map;
      if (mask !== null) entry.maskUrl = mask;
      colorways[colorway.id] = entry;
    }
    out.views[viewId] = { colorways, h: view.h, printArea: copyRect(view.printArea), w: view.w };
    if (view.printAreaMm !== null) out.printAreaMm[viewId] = { h: view.printAreaMm.h, w: view.printAreaMm.w };
  }
  return out;
}

async function filesFor(db: D1Database, fileIds: string[]): Promise<Map<string, StudioFileRow>> {
  return readActiveStudioFiles(db, fileIds);
}

/**
 * GET /v1/admin/pod/mockup-templates: the ACTIVE templates in their order, in
 * the Firebase document's shape. `provisional` is true when any of them is a
 * stand-in (the studio's "preliminära" banner read it off the document).
 */
export async function listSellerTemplates(
  env: Env,
  db: D1Database,
): Promise<{ provisional: boolean; templates: SellerTemplate[] }> {
  const stored = await readTemplates(db, { activeOnly: true });
  const files = await filesFor(db, stored.flatMap((entry) => templateFileIds(entry.input)));
  const urlOf = urlResolver(files, publicObjectBase(env));
  return {
    provisional: stored.some((entry) => entry.input.provisional),
    templates: stored.map((entry) => sellerTemplate(entry, urlOf)),
  };
}

/** GET /v1/admin/pod/3d-models: the ACTIVE models, by label, in the Firebase shape. */
export async function listSellerModels(env: Env, db: D1Database): Promise<{ models: SellerModel[] }> {
  const stored = await readModels(db, { activeOnly: true });
  const files = await filesFor(db, stored.flatMap((entry) => modelFileIds(entry.input)));
  const urlOf = urlResolver(files, publicObjectBase(env));
  return { models: stored.map((entry) => sellerModel(entry, urlOf)) };
}

// ── the platform's shapes ───────────────────────────────────────────────────

export type PlatformTemplate = MockupTemplateInput & { createdAt: string; templateId: string; updatedAt: string };
export type PlatformModel = Model3dInput & { createdAt: string; modelId: string; updatedAt: string };

function platformTemplate(stored: StoredTemplate): PlatformTemplate {
  return { ...stored.input, createdAt: stored.createdAt, templateId: stored.templateId, updatedAt: stored.updatedAt };
}

function platformModel(stored: StoredModel): PlatformModel {
  return { ...stored.input, createdAt: stored.createdAt, modelId: stored.modelId, updatedAt: stored.updatedAt };
}

function filesView(files: Map<string, StudioFileRow>, base: string | null): Record<string, StudioFile> {
  return Object.fromEntries([...files.values()].map((row) => [row.file_id, toStudioFile(row, base)]));
}

/** GET /v1/platform/pod/mockup-templates: every template, and the files they name. */
export async function listPlatformTemplates(
  env: Env,
  db: D1Database,
): Promise<{ files: Record<string, StudioFile>; templates: PlatformTemplate[] }> {
  const stored = await readTemplates(db, { activeOnly: false });
  const files = await filesFor(db, stored.flatMap((entry) => templateFileIds(entry.input)));
  return { files: filesView(files, publicObjectBase(env)), templates: stored.map(platformTemplate) };
}

export async function listPlatformModels(
  env: Env,
  db: D1Database,
): Promise<{ files: Record<string, StudioFile>; models: PlatformModel[] }> {
  const stored = await readModels(db, { activeOnly: false });
  const files = await filesFor(db, stored.flatMap((entry) => modelFileIds(entry.input)));
  return { files: filesView(files, publicObjectBase(env)), models: stored.map(platformModel) };
}

// ── writes (platform principal only) ────────────────────────────────────────

export type PutResult<T> =
  | { changed: boolean; created: boolean; status: "ok"; value: T }
  | { reason: string; status: "invalid" }
  | { status: "limit" };

function auditStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      principal.userId,
      action,
      resourceType,
      resourceId,
      crypto.randomUUID(),
      JSON.stringify(metadata),
      now,
    );
}

async function countRows(db: D1Database, table: "pod_3d_models" | "pod_mockup_templates"): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Create or replace a template whole (its areas and colourways with it), in
 * one batch with its audit row. The same document again changes nothing and
 * writes nothing (`changed: false`): an import that is run twice is a no-op.
 * Refused: a file that is not an active studio file (`file_not_found`), a
 * new template past MAX_TEMPLATES (`limit`).
 */
export async function putMockupTemplate(
  db: D1Database,
  principal: PlatformPrincipal,
  templateId: string,
  input: MockupTemplateInput,
  now: number,
): Promise<PutResult<PlatformTemplate>> {
  const fileIds = templateFileIds(input);
  const files = await readActiveStudioFiles(db, fileIds);
  if (fileIds.some((id) => !files.has(id))) {
    return { reason: "file_not_found", status: "invalid" };
  }
  const [existing] = await readTemplates(db, { activeOnly: false, templateId });
  if (existing !== undefined && stableJson(existing.input) === stableJson(input)) {
    return { changed: false, created: false, status: "ok", value: platformTemplate(existing) };
  }
  if (existing === undefined && (await countRows(db, "pod_mockup_templates")) >= MAX_TEMPLATES) {
    return { status: "limit" };
  }

  const at = iso(now);
  const map = input.photo?.displacement ?? null;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO pod_mockup_templates (
           template_id, label, garment, profile_id, active, provisional, sort_order,
           photo_w_px, photo_h_px, map_w_px, map_h_px, map_front_file_id, map_back_file_id,
           map_scale, map_blur, map_contrast, map_blend, map_alpha,
           pocket_left_x_px, pocket_center_x_px, pocket_right_x_px,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (template_id) DO UPDATE SET
           label = excluded.label, garment = excluded.garment, profile_id = excluded.profile_id,
           active = excluded.active, provisional = excluded.provisional,
           sort_order = excluded.sort_order, photo_w_px = excluded.photo_w_px,
           photo_h_px = excluded.photo_h_px, map_w_px = excluded.map_w_px,
           map_h_px = excluded.map_h_px, map_front_file_id = excluded.map_front_file_id,
           map_back_file_id = excluded.map_back_file_id, map_scale = excluded.map_scale,
           map_blur = excluded.map_blur, map_contrast = excluded.map_contrast,
           map_blend = excluded.map_blend, map_alpha = excluded.map_alpha,
           pocket_left_x_px = excluded.pocket_left_x_px,
           pocket_center_x_px = excluded.pocket_center_x_px,
           pocket_right_x_px = excluded.pocket_right_x_px,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(
        templateId,
        input.label,
        input.garment,
        input.profileId,
        input.active ? 1 : 0,
        input.provisional ? 1 : 0,
        input.sortOrder,
        input.photo?.w ?? null,
        input.photo?.h ?? null,
        map?.w ?? null,
        map?.h ?? null,
        map?.frontFileId ?? null,
        map?.backFileId ?? null,
        map?.scale ?? null,
        map?.blur ?? null,
        map?.contrast ?? null,
        map?.blend ?? null,
        map?.alpha ?? null,
        input.pocketPositions?.left?.x ?? null,
        input.pocketPositions?.center?.x ?? null,
        input.pocketPositions?.right?.x ?? null,
        principal.userId,
        principal.userId,
        at,
        at,
      ),
    db.prepare("DELETE FROM pod_mockup_template_areas WHERE template_id = ?").bind(templateId),
    db.prepare("DELETE FROM pod_mockup_template_colorways WHERE template_id = ?").bind(templateId),
  ];
  for (const slot of slotsOf(input.printAreas)) {
    const rect = input.printAreas[slot] as Rect;
    const mm = input.printAreaMm[slot] as Size;
    statements.push(
      db
        .prepare(
          `INSERT INTO pod_mockup_template_areas (
             template_id, slot, x_px, y_px, w_px, h_px, w_mm, h_mm, offset_top_mm, slot_label
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          templateId,
          slot,
          rect.x,
          rect.y,
          rect.w,
          rect.h,
          mm.w,
          mm.h,
          input.printOffsetTopMm?.[slot] ?? null,
          input.slotLabels?.[slot] ?? null,
        ),
    );
  }
  input.colorways.forEach((colorway, position) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO pod_mockup_template_colorways (
             template_id, colorway_id, position, label, hex, front_file_id, back_file_id,
             blend, alpha, displacement_scale, displacement_blur, displacement_contrast
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          templateId,
          colorway.id,
          position,
          colorway.label,
          colorway.hex,
          colorway.frontFileId,
          colorway.backFileId,
          colorway.tuning?.blend ?? null,
          colorway.tuning?.alpha ?? null,
          colorway.tuning?.displacementScale ?? null,
          colorway.tuning?.displacementBlur ?? null,
          colorway.tuning?.displacementContrast ?? null,
        ),
    );
  });
  statements.push(
    auditStatement(
      db,
      principal,
      existing === undefined ? "pod.mockup_template.create" : "pod.mockup_template.update",
      "pod_mockup_template",
      templateId,
      { active: input.active, colorways: input.colorways.length, garment: input.garment, slots: slotsOf(input.printAreas) },
      now,
    ),
  );
  await db.batch(statements);

  const [written] = await readTemplates(db, { activeOnly: false, templateId });
  if (written === undefined) {
    throw new Error("the written template could not be read back");
  }
  return { changed: true, created: existing === undefined, status: "ok", value: platformTemplate(written) };
}

/**
 * Create or replace a 3D model whole (views and colourways with it). As the
 * template write; also refused: a colourway whose photo, map and mask are not
 * one registered set (`not_registered`).
 */
export async function putModel3d(
  db: D1Database,
  principal: PlatformPrincipal,
  modelId: string,
  input: Model3dInput,
  now: number,
): Promise<PutResult<PlatformModel>> {
  const fileIds = modelFileIds(input);
  const files = await readActiveStudioFiles(db, fileIds);
  if (fileIds.some((id) => !files.has(id))) {
    return { reason: "file_not_found", status: "invalid" };
  }
  if (!modelFilesRegistered(input, files)) {
    return { reason: "not_registered", status: "invalid" };
  }
  const [existing] = await readModels(db, { activeOnly: false, modelId });
  if (existing !== undefined && stableJson(existing.input) === stableJson(input)) {
    return { changed: false, created: false, status: "ok", value: platformModel(existing) };
  }
  if (existing === undefined && (await countRows(db, "pod_3d_models")) >= MAX_MODELS) {
    return { status: "limit" };
  }

  const at = iso(now);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO pod_3d_models (
           model_id, label, active, displacement_scale, displacement_blur, displacement_contrast,
           blend, alpha, output_w_px, output_h_px, per_colorway_json,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model_id) DO UPDATE SET
           label = excluded.label, active = excluded.active,
           displacement_scale = excluded.displacement_scale,
           displacement_blur = excluded.displacement_blur,
           displacement_contrast = excluded.displacement_contrast,
           blend = excluded.blend, alpha = excluded.alpha,
           output_w_px = excluded.output_w_px, output_h_px = excluded.output_h_px,
           per_colorway_json = excluded.per_colorway_json,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(
        modelId,
        input.label,
        input.active ? 1 : 0,
        input.displacementScale ?? null,
        input.displacementBlur ?? null,
        input.displacementContrast ?? null,
        input.blend ?? null,
        input.alpha ?? null,
        input.output?.w ?? null,
        input.output?.h ?? null,
        JSON.stringify(input.perColorway),
        principal.userId,
        principal.userId,
        at,
        at,
      ),
    // Colourways first: they reference their view.
    db.prepare("DELETE FROM pod_3d_model_colorways WHERE model_id = ?").bind(modelId),
    db.prepare("DELETE FROM pod_3d_model_views WHERE model_id = ?").bind(modelId),
  ];
  let colorwayCount = 0;
  for (const viewId of MODEL_VIEWS) {
    const view = input.views[viewId];
    if (view === undefined) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO pod_3d_model_views (
             model_id, view_id, w_px, h_px, print_x_px, print_y_px, print_w_px, print_h_px,
             print_w_mm, print_h_mm, original_w_px, original_h_px
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          modelId,
          viewId,
          view.w,
          view.h,
          view.printArea.x,
          view.printArea.y,
          view.printArea.w,
          view.printArea.h,
          view.printAreaMm?.w ?? null,
          view.printAreaMm?.h ?? null,
          view.originalDims?.w ?? null,
          view.originalDims?.h ?? null,
        ),
    );
    view.colorways.forEach((colorway, position) => {
      colorwayCount += 1;
      statements.push(
        db
          .prepare(
            `INSERT INTO pod_3d_model_colorways (
               model_id, view_id, colorway_id, position, label, photo_file_id,
               displacement_file_id, mask_file_id, map_contrast_sd
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            modelId,
            viewId,
            colorway.id,
            position,
            colorway.label,
            colorway.photoFileId,
            colorway.displacementFileId,
            colorway.maskFileId,
            colorway.mapContrastSd ?? null,
          ),
      );
    });
  }
  statements.push(
    auditStatement(
      db,
      principal,
      existing === undefined ? "pod.3d_model.create" : "pod.3d_model.update",
      "pod_3d_model",
      modelId,
      { active: input.active, colorways: colorwayCount, views: MODEL_VIEWS.filter((v) => input.views[v]) },
      now,
    ),
  );
  await db.batch(statements);

  const [written] = await readModels(db, { activeOnly: false, modelId });
  if (written === undefined) {
    throw new Error("the written model could not be read back");
  }
  return { changed: true, created: existing === undefined, status: "ok", value: platformModel(written) };
}

/** PATCH …/:id { active } — the body. */
export function parseActiveInput(body: unknown): boolean | null {
  return isPlainObject(body) && hasOnlyKeys(body, ["active"]) && typeof body.active === "boolean"
    ? body.active
    : null;
}

export type SetActiveResult<T> = { changed: boolean; status: "ok"; value: T } | { status: "not_found" };

/** Activate or deactivate a template; audited when it changes anything. */
export async function setMockupTemplateActive(
  db: D1Database,
  principal: PlatformPrincipal,
  templateId: string,
  active: boolean,
  now: number,
): Promise<SetActiveResult<PlatformTemplate>> {
  const [existing] = await readTemplates(db, { activeOnly: false, templateId });
  if (existing === undefined) {
    return { status: "not_found" };
  }
  if (existing.input.active === active) {
    return { changed: false, status: "ok", value: platformTemplate(existing) };
  }
  await db.batch([
    db
      .prepare(
        `UPDATE pod_mockup_templates SET active = ?, updated_by = ?, updated_at = ?
         WHERE template_id = ?`,
      )
      .bind(active ? 1 : 0, principal.userId, iso(now), templateId),
    auditStatement(
      db,
      principal,
      active ? "pod.mockup_template.activate" : "pod.mockup_template.deactivate",
      "pod_mockup_template",
      templateId,
      { active },
      now,
    ),
  ]);
  const [written] = await readTemplates(db, { activeOnly: false, templateId });
  return written === undefined
    ? { status: "not_found" }
    : { changed: true, status: "ok", value: platformTemplate(written) };
}

export async function setModel3dActive(
  db: D1Database,
  principal: PlatformPrincipal,
  modelId: string,
  active: boolean,
  now: number,
): Promise<SetActiveResult<PlatformModel>> {
  const [existing] = await readModels(db, { activeOnly: false, modelId });
  if (existing === undefined) {
    return { status: "not_found" };
  }
  if (existing.input.active === active) {
    return { changed: false, status: "ok", value: platformModel(existing) };
  }
  await db.batch([
    db
      .prepare("UPDATE pod_3d_models SET active = ?, updated_by = ?, updated_at = ? WHERE model_id = ?")
      .bind(active ? 1 : 0, principal.userId, iso(now), modelId),
    auditStatement(
      db,
      principal,
      active ? "pod.3d_model.activate" : "pod.3d_model.deactivate",
      "pod_3d_model",
      modelId,
      { active },
      now,
    ),
  ]);
  const [written] = await readModels(db, { activeOnly: false, modelId });
  return written === undefined
    ? { status: "not_found" }
    : { changed: true, status: "ok", value: platformModel(written) };
}
