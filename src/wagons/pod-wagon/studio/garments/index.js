// garments/index.js — registry of garment flats keyed by the template's `garment`
// field (settings/podMockupTemplates). SLOT-AWARE since step 3 (docs/POD_PRINT_SPEC.md):
// each garment maps to its VIEWS ({ front, back? }) — the back slot renders on the
// back-view flat, every other slot (front/pocket/sleeves) on the front view, and a
// garment without a back view falls back to front (TemplateBackground.flatForSlot).
// Adding a garment: drop a *Flat.jsx (matching the TeeFlat pattern), register its
// views + viewBox below, and give it a template in seed-pod-mockup-templates.cjs.
import TeeFlat, { TEE_VIEWBOX } from './TeeFlat';
import TeeBackFlat from './TeeBackFlat';
import HoodieFlat, { HOODIE_VIEWBOX } from './HoodieFlat';
import HoodieBackFlat from './HoodieBackFlat';
import SweatshirtFlat, { SWEATSHIRT_VIEWBOX } from './SweatshirtFlat';
import SweatshirtBackFlat from './SweatshirtBackFlat';
import BagFlat, { BAG_VIEWBOX } from './BagFlat';
import CapFlat, { CAP_VIEWBOX } from './CapFlat';
import BeanieFlat, { BEANIE_VIEWBOX } from './BeanieFlat';
import FlatCapFlat, { FLAT_CAP_VIEWBOX } from './FlatCapFlat';

// garment key → view map of React components (each takes a `color` prop).
export const GARMENT_FLATS = {
  tee: { front: TeeFlat, back: TeeBackFlat },
  hoodie: { front: HoodieFlat, back: HoodieBackFlat },
  sweatshirt: { front: SweatshirtFlat, back: SweatshirtBackFlat },
  bag: { front: BagFlat },
  cap: { front: CapFlat },
  beanie: { front: BeanieFlat },
  flatcap: { front: FlatCapFlat },
};

// garment key → the flat's SVG viewBox { w, h } (print-area px coords are in this
// space; front and back views of a garment share the same viewBox).
export const GARMENT_VIEWBOX = {
  tee: TEE_VIEWBOX,
  hoodie: HOODIE_VIEWBOX,
  sweatshirt: SWEATSHIRT_VIEWBOX,
  bag: BAG_VIEWBOX,
  cap: CAP_VIEWBOX,
  beanie: BEANIE_VIEWBOX,
  flatcap: FLAT_CAP_VIEWBOX,
};

export { TeeFlat, HoodieFlat, TEE_VIEWBOX, HOODIE_VIEWBOX };
