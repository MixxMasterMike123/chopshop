// ProductMapping's data layer: the OLDER build's implementation (Firebase).
// The code below moved here unchanged from ProductMapping.jsx (CP5 unit FM),
// so the component is the same file in both builds; the Cloudflare admin's
// build aliases this module to src/admin-app/replacements/podProductMappingData.js
// (vite.admin.config.js), which exports the same names.
import toast from 'react-hot-toast';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../../firebase/config';
import { setMapping, deleteMapping } from '../../../utils/podMappings';
import { slotLabel } from '../../../config/podSlots';

/** This build maps a SKU to a garment + one placement (no printer article). */
export const PRINTER_ROUTED = false;

/** The printer/article/slots choice of the other build: none here. */
export const usePrinterChoice = () => null;

/** Every artwork may be picked (the tier is shown beside it). */
export const selectableForMapping = () => true;

export const MAPPING_INTRO =
  'Designstudion kopplar motiv och placering automatiskt när en produkt skapas eller uppdateras. Använd bara den här avancerade vyn för att reparera en äldre produkt eller koppla en produkt som inte skapats i Designstudion.';

/** → { message } for the success toast. */
export const addMapping = async ({ shopId, sku, artworkId, art, placement, placementSlot, garment }) => {
  const { replaced } = await setMapping({
    shopId, sku, artworkId, profileId: art?.purpose || null, placement, placementSlot,
    // The garment is the print-routing key. A hand-made mapping has no studio
    // template to read it from, so the seller picks it. Since SnapWear A4 a
    // mapping without one routes NOWHERE and checkout refuses the line — so
    // the form requires it.
    garment,
  });
  // Same product+slot replaces that slot's artwork — say so explicitly.
  return { message: replaced ? `Ersatte tidigare koppling för ${slotLabel(placementSlot)}` : 'Koppling sparad' };
};

export const removeMapping = async ({ m, mappings, products }) => {
  await deleteMapping(m.id);

  // STRAND-GUARD (P1 2026-08-15): if this was the sku's LAST covering row,
  // any live POD product it fed is now unprintable — unpublish it rather
  // than let orders keep arriving for a file the printer will never get.
  // Coverage mirrors ProductForm/the print pipeline: parent-sku mapping
  // covers everything; otherwise every variant-group sku must be mapped.
  const remaining = new Set(
    mappings.filter((row) => row.id !== m.id && row.sku).map((row) => row.sku)
  );
  const covered = (prod) => {
    if (prod.sku && remaining.has(prod.sku)) return true;
    const groups = (prod.variants || []).map((v) => v?.sku).filter(Boolean);
    return groups.length > 0 && groups.every((sku) => remaining.has(sku));
  };
  const stranded = products.filter((prod) =>
    prod.isPodProduct === true
    && prod.b2cAvailable !== false
    && (prod.sku === m.sku || (prod.variants || []).some((v) => v?.sku === m.sku))
    && !covered(prod)
  );
  for (const prod of stranded) {
    await updateDoc(doc(db, 'products', prod.id), {
      'availability.b2c': false,
      updatedAt: serverTimestamp(),
    });
    toast(`"${prod.name || prod.sku}" avpublicerades — tryckkopplingen togs bort.`, { icon: '🔒' });
  }
};
