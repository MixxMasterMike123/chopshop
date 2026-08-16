// Live photo-displacement layer for the ordinary step-4 placement canvas.
// The Pixi engine itself is dynamically imported so it stays out of the main
// studio bundle until a template actually has registered fabric maps.
//
// CANVAS LIFECYCLE (same pattern as the proven DisplacementPreview): the
// compositor OWNS its canvas, and this component appends it to a host <div>
// only after init + first verified render. Until then the parent's flat DOM
// artwork stays fully visible (`onReadyChange(false)`), so the seller never
// sees the black window a fresh WebGL canvas shows while the context spins up
// and the photo/map textures load. Handing Pixi a React-owned canvas is off
// the table: destroy() loses the context, and a StrictMode re-run or effect
// re-run would then re-init on a canvas that can never render again.
import React, { useEffect, useRef } from 'react';
import {
  backgroundUrl, templateViewBox, viewForSlot, displacementTuningFor,
} from '../TemplateBackground';

const DisplacedTemplatePreview = ({
  template, colorway, slot, artworkUrl, placement,
  onError = () => {}, onReadyChange = () => {},
}) => {
  const hostRef = useRef(null);
  const compositorRef = useRef(null);
  const placementRef = useRef(placement);
  const photoUrlRef = useRef(null);
  const artworkUrlRef = useRef(artworkUrl);
  const surfaceRef = useRef(null);
  placementRef.current = placement;

  const viewBox = templateViewBox(template);
  const displacement = template?.photo?.displacement;
  const mapUrl = displacement?.urls?.[viewForSlot(slot)] || null;
  const photoUrl = backgroundUrl(template, colorway, slot);
  photoUrlRef.current = photoUrl;
  artworkUrlRef.current = artworkUrl;
  // Blend/alpha depend on the COLOURWAY (multiply on light, normal on dark);
  // kept in a ref so the mount effect always reads the current colour's tuning.
  const tuning = displacementTuningFor(displacement, colorway?.id);
  const tuningRef = useRef(tuning);
  tuningRef.current = tuning;
  const area = template?.printAreas?.[slot];
  const areaMm = template?.printAreaMm?.[slot];
  const mapW = displacement?.w || viewBox?.w;
  const mapH = displacement?.h || viewBox?.h;
  const sx = viewBox?.w ? mapW / viewBox.w : 1;
  const sy = viewBox?.h ? mapH / viewBox.h : 1;
  const surface = area && areaMm && mapUrl ? {
    key: `${mapUrl}:${area.x}:${area.y}:${area.w}:${area.h}:${areaMm.w}:${areaMm.h}`,
    displacementUrl: mapUrl,
    printArea: {
      x: area.x * sx,
      y: area.y * sy,
      w: area.w * sx,
      h: area.h * sy,
    },
    printAreaMm: areaMm,
  } : null;
  surfaceRef.current = surface;

  useEffect(() => {
    let cancelled = false;
    let compositor = null;
    if (!viewBox || !surfaceRef.current || !photoUrlRef.current || !artworkUrlRef.current) return undefined;

    (async () => {
      try {
        const initialPhotoUrl = photoUrlRef.current;
        const initialSurface = surfaceRef.current;
        const { createDisplacementCompositor } = await import('./displacementCompositor');
        compositor = await createDisplacementCompositor({
          view: {
            w: mapW,
            h: mapH,
            printArea: initialSurface.printArea,
          },
          printAreaMm: initialSurface.printAreaMm,
          assets: { photoUrl: initialPhotoUrl, displacementUrl: initialSurface.displacementUrl },
          // Context revoked under GPU pressure → drop straight to the flat DOM
          // preview via the parent's error path (the compositor is inert now).
          onContextLost: () => onError(new Error('WebGL-kontexten gick förlorad.')),
          tuning: tuningRef.current,
          // The map retains its full-resolution coordinate field, while the live
          // canvas only renders at the template/display resolution for snappy drag.
          output: { w: viewBox.w, h: viewBox.h },
        });
        if (cancelled) { compositor.destroy(); return; }
        await compositor.setArtwork(artworkUrlRef.current);
        if (cancelled) { compositor.destroy(); return; }
        if (photoUrlRef.current !== initialPhotoUrl) {
          await compositor.setPhoto(photoUrlRef.current);
        }
        if (cancelled) { compositor.destroy(); return; }
        if (surfaceRef.current?.key !== initialSurface.key) {
          await compositor.setSurface(surfaceRef.current);
        }
        if (cancelled) { compositor.destroy(); return; }
        compositor.setTuning(tuningRef.current); // colourway may have changed mid-init
        compositor.setPlacement(placementRef.current);
        if (!compositor.hasVisibleArtwork()) {
          throw new Error('WebGL-renderingen utelämnade motivet.');
        }
        if (cancelled || !hostRef.current) { compositor.destroy(); return; }
        // Verified — only now does the canvas become visible, replacing the
        // parent's flat artwork in one frame (no black/loading state on screen).
        const canvas = compositor.canvas;
        canvas.className = 'pointer-events-none absolute inset-0 block h-auto w-full';
        canvas.setAttribute('aria-hidden', 'true');
        hostRef.current.appendChild(canvas);
        compositorRef.current = compositor;
        onReadyChange(true);
      } catch (error) {
        try { compositor?.destroy(); } catch { /* renderer may already be invalid */ }
        if (!cancelled) onError(error);
      }
    })();

    return () => {
      cancelled = true;
      onReadyChange(false);
      if (compositorRef.current === compositor) compositorRef.current = null;
      try { compositor?.destroy(); } catch { /* already torn down */ }
    };
  }, [
    template?.id, viewBox?.w, viewBox?.h, displacement?.w, displacement?.h,
    displacement?.scale, displacement?.blur, displacement?.contrast,
    displacement?.blend, displacement?.alpha, onError, onReadyChange,
  ]);

  // Front/back changes hot-swap the registered map and physical print geometry
  // inside the same WebGL renderer; no context teardown/recreation on navigation.
  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor || !surface) return;
    compositor.setSurface(surface).catch(onError);
  }, [surface?.key]);

  // Colour changes replace one photo texture inside the existing renderer. The
  // full-resolution displacement map and WebGL context are deliberately reused.
  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor || !photoUrl) return;
    compositor.setPhoto(photoUrl).catch(onError);
  }, [photoUrl]);

  // …and the colourway's blend tuning follows (multiply↔normal across the
  // light/dark boundary; contrast stays uniform so no map rebuild happens).
  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;
    try { compositor.setTuning(tuningRef.current); } catch (error) { onError(error); }
  }, [colorway?.id]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor || !artworkUrl) return;
    compositor.setArtwork(artworkUrl).catch(onError);
  }, [artworkUrl]);

  useEffect(() => {
    if (!placement) return;
    try { compositorRef.current?.setPlacement(placement); } catch (error) { onError(error); }
  }, [placement?.xMm, placement?.yMm, placement?.wMm, placement?.rotationDeg]);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
  );
};

export default DisplacedTemplatePreview;
