// Live photo-displacement layer for the ordinary step-4 placement canvas.
// This module is lazy-loaded by CompositorCanvas so Pixi stays out of the main
// studio bundle until a template actually has registered fabric maps.
import React, { useEffect, useRef } from 'react';
import { backgroundUrl, templateViewBox, viewForSlot } from '../TemplateBackground';

const DisplacedTemplatePreview = ({
  template, colorway, slot, artworkUrl, placement,
}) => {
  const canvasRef = useRef(null);
  const compositorRef = useRef(null);
  const placementRef = useRef(placement);
  placementRef.current = placement;

  const viewBox = templateViewBox(template);
  const displacement = template?.photo?.displacement;
  const mapUrl = displacement?.urls?.[viewForSlot(slot)] || null;
  const photoUrl = backgroundUrl(template, colorway, slot);
  const area = template?.printAreas?.[slot];
  const areaMm = template?.printAreaMm?.[slot];

  useEffect(() => {
    let cancelled = false;
    let compositor = null;
    const canvas = canvasRef.current;
    if (!canvas || !viewBox || !mapUrl || !photoUrl || !area || !areaMm || !artworkUrl) return undefined;

    const mapW = displacement.w || viewBox.w;
    const mapH = displacement.h || viewBox.h;
    const sx = mapW / viewBox.w;
    const sy = mapH / viewBox.h;

    (async () => {
      try {
        const { createDisplacementCompositor } = await import('./displacementCompositor');
        compositor = await createDisplacementCompositor({
          view: {
            w: mapW,
            h: mapH,
            printArea: {
              x: area.x * sx,
              y: area.y * sy,
              w: area.w * sx,
              h: area.h * sy,
            },
          },
          printAreaMm: areaMm,
          assets: { photoUrl, displacementUrl: mapUrl },
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
        await compositor.setArtwork(artworkUrl);
        compositor.setPlacement(placementRef.current);
        if (cancelled) {
          compositor.destroy();
          return;
        }
        compositorRef.current = compositor;
      } catch {
        compositor?.destroy();
      }
    })();

    return () => {
      cancelled = true;
      if (compositorRef.current === compositor) compositorRef.current = null;
      compositor?.destroy();
    };
  }, [
    template?.id, colorway?.id, slot, artworkUrl, photoUrl, mapUrl,
    viewBox?.w, viewBox?.h, area?.x, area?.y, area?.w, area?.h,
    areaMm?.w, areaMm?.h, displacement?.w, displacement?.h,
    displacement?.scale, displacement?.blur, displacement?.contrast,
    displacement?.blend, displacement?.alpha,
  ]);

  useEffect(() => {
    if (placement) compositorRef.current?.setPlacement(placement);
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
