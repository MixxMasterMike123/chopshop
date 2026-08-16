// Live photo-displacement layer for the ordinary step-4 placement canvas.
// The Pixi engine itself is dynamically imported so it stays out of the main
// studio bundle until a template actually has registered fabric maps.
import React, { useEffect, useRef } from 'react';
import { backgroundUrl, templateViewBox, viewForSlot } from '../TemplateBackground';

const DisplacedTemplatePreview = ({
  template, colorway, slot, artworkUrl, placement, onError = () => {},
}) => {
  const canvasRef = useRef(null);
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
    const canvas = canvasRef.current;
    if (!canvas || !viewBox || !surfaceRef.current || !photoUrlRef.current || !artworkUrlRef.current) return undefined;

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
          tuning: {
            displacementScale: displacement.scale ?? 30,
            displacementBlur: displacement.blur ?? 6,
            displacementContrast: displacement.contrast ?? 1,
            blend: displacement.blend || 'multiply',
            alpha: displacement.alpha ?? 0.8,
          },
          // The map retains its full-resolution coordinate field, while the live
          // canvas only renders at the template/display resolution for snappy drag.
          output: { w: viewBox.w, h: viewBox.h, canvas },
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
        compositor.setPlacement(placementRef.current);
        if (!compositor.hasVisibleArtwork()) {
          throw new Error('WebGL-renderingen utelämnade motivet.');
        }
        compositorRef.current = compositor;
      } catch (error) {
        try { compositor?.destroy(); } catch { /* renderer may already be invalid */ }
        if (!cancelled) onError(error);
      }
    })();

    return () => {
      cancelled = true;
      if (compositorRef.current === compositor) compositorRef.current = null;
      try { compositor?.destroy(); } catch { /* already torn down */ }
    };
  }, [
    template?.id, viewBox?.w, viewBox?.h, displacement?.w, displacement?.h,
    displacement?.scale, displacement?.blur, displacement?.contrast,
    displacement?.blend, displacement?.alpha, onError,
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
    <canvas
      ref={canvasRef}
      width={viewBox?.w || 1}
      height={viewBox?.h || 1}
      className="pointer-events-none absolute inset-0 block h-auto w-full"
      aria-hidden="true"
    />
  );
};

export default DisplacedTemplatePreview;
