// ArtworkUploadModal — the seller's artwork upload + GATE flow.
//
// SSOT: docs/POD_PRINT_SPEC.md (print shop specs 2026-07-27). The gate BLOCKS:
// artwork that can't print at ≥300 DPI never enters the library. Flow:
//   pick profile → pick file → CLIENT pre-check (gateArtwork — instant feedback)
//   → on save: upload original → processPodArtwork callable (sharp: PNG-convert,
//   trim, sRGB, authoritative gate, writes print PNG + preview) → on PASS create
//   the podArtwork doc (status 'ready'); on FAIL show the rejection (the server
//   already deleted the original — nothing persists).
//
// Transparency INFORMS, never blocks (opaque notice + honest mockups). Design:
// Admin-Neutral, mirrors the dark-overlay modal pattern with admin tokens.
import React, { useState, useEffect } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { httpsCallable } from 'firebase/functions';
import { Field, Input, Select, Button } from '../../../components/admin/ui';
import StatusPill from '../../../components/admin/ui/StatusPill';
import { loadPodProfiles, getProfileById } from '../../../config/podProfiles';
import { readImageDimensions, uploadPodOriginal, extOf, sha256Hex } from '../../../utils/podUpload';
import { gateArtwork, normalizeExt } from '../../../utils/podValidation';
import { createArtwork, replaceArtworkFile } from '../../../utils/podArtwork';
import { auth, functions } from '../../../firebase/config';
import { tierTone, tierLabel } from './podTier';

// Checkerboard behind the preview so all-white/light motifs read as motifs, not
// as "empty" (spec §8 Färg) — and so transparency is visibly transparent.
const CHECKER_STYLE = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,.18) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.18) 75%), ' +
    'linear-gradient(45deg, rgba(128,128,128,.18) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.18) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 8px 8px',
};

// `replaceTarget` (optional): REPLACE mode — profile locked to the existing
// artwork's, confirming updates that doc in place (same id → all products +
// unshipped queue orders get the new file); no post-upload mapping prompt.
// `artwork`: the shop's existing library (duplicate detection via sha256).
const ArtworkUploadModal = ({ shopId, artwork = [], onClose, onCreated, onUseInStudio, replaceTarget = null }) => {
  const isReplace = !!replaceTarget;
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState(null);
  const [measuring, setMeasuring] = useState(false);
  const [measured, setMeasured] = useState(null);   // { widthPx, heightPx, hasAlphaChannel, transparentPixelRatio, previewObjUrl, sha256 }
  const [clientGate, setClientGate] = useState(null); // gateArtwork() result (pre-check)
  const [rightsOk, setRightsOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverReject, setServerReject] = useState(null); // [{code,message}] from the authoritative gate
  const [notices, setNotices] = useState([]);             // server notices after PASS

  // Successful uploads lead into Studio; product-specific mappings are created
  // automatically only when the design is published.
  const [createdArtworkId, setCreatedArtworkId] = useState(null);

  useEffect(() => {
    loadPodProfiles().then((p) => {
      setProfiles(p);
      const target = isReplace ? (replaceTarget.purpose || p[0]?.id) : p[0]?.id;
      if (p.length && !profileId) setProfileId(target || '');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profile = getProfileById(profiles, profileId);

  // The current preview object URL — revoked when replaced or on unmount so a
  // seller cycling through big files doesn't pin every decoded image in memory.
  const previewUrlRef = React.useRef(null);
  const swapPreviewUrl = (next) => {
    if (previewUrlRef.current && previewUrlRef.current !== next) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = next || null;
  };
  useEffect(() => () => swapPreviewUrl(null), []);

  // Pre-check whenever the file or profile changes. TIFF can't be decoded in the
  // browser → px checks are skipped here; the server (which always decodes) rules.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setServerReject(null);
      if (!file || !profile) { setMeasured(null); setClientGate(null); swapPreviewUrl(null); return; }
      setMeasuring(true);
      try {
        const [dims, probe, sha256] = await Promise.all([
          readImageDimensions(file),
          probeAlpha(file),
          sha256Hex(file).catch(() => null),
        ]);
        if (cancelled) {
          if (probe.previewObjUrl) URL.revokeObjectURL(probe.previewObjUrl);
          return;
        }
        swapPreviewUrl(probe.previewObjUrl);
        setMeasured({
          widthPx: dims.width, heightPx: dims.height,
          hasAlphaChannel: probe.hasAlphaChannel,
          transparentPixelRatio: probe.transparentPixelRatio,
          previewObjUrl: probe.previewObjUrl,
          sha256,
        });
        setClientGate(gateArtwork({
          widthPx: dims.width, heightPx: dims.height,
          ext: extOf(file.name), fileSizeBytes: file.size,
        }, profile));
      } finally {
        if (!cancelled) setMeasuring(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, profileId, profiles]);

  const onPick = (e) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    setRightsOk(false);
    // Synchronous: the measure effect runs a tick later — without this a fast
    // Save click between pick and effect could pair file B with file A's verdict.
    if (f) setMeasuring(true);
    if (f && !label) setLabel(f.name.replace(/\.[a-z0-9]+$/i, ''));
  };

  // Duplicate: same bytes already in the library (INFORM, never block — spec §8).
  const duplicateOf = measured?.sha256
    ? artwork.find((a) => a.sha256 === measured.sha256 && a.id !== replaceTarget?.id)
    : null;

  // Client-side opaque hint (pre-upload). The server re-derives this authoritatively.
  const looksOpaque =
    measured && (
      measured.hasAlphaChannel === false ||
      (measured.hasAlphaChannel === true && typeof measured.transparentPixelRatio === 'number' && measured.transparentPixelRatio < 0.005)
    );

  const dimsUnknown = !!file && measured && measured.widthPx == null;
  const blocked = !!clientGate && !clientGate.ok;

  const handleSave = async () => {
    // serverReject is deterministic for the same bytes — block re-tries until the
    // seller picks a different file (the effect clears it on file/profile change).
    if (!file || !profile || saving || blocked || !rightsOk || serverReject) return;
    setSaving(true);
    setServerReject(null);
    try {
      const original = await uploadPodOriginal(file, shopId, profile);
      // The AUTHORITATIVE gate + conversion (sharp). On reject the server has
      // already deleted the uploaded original — nothing persists.
      const call = httpsCallable(functions, 'processPodArtwork');
      const { data: result } = await call({
        shopId,
        originalStoragePath: original.originalStoragePath,
        profileId: profile.id,
      });

      if (!result?.ok) {
        setServerReject(result?.reasons || [{ code: 'unknown', message: 'Filen godkändes inte.' }]);
        setSaving(false);
        return;
      }

      const fileFields = {
        originalUrl: original.originalUrl,
        originalStoragePath: original.originalStoragePath,
        fileName: original.fileName,
        fileSizeBytes: original.fileSizeBytes,
        mimeType: original.mimeType,
        ext: original.ext,
        sha256: measured?.sha256 || null,
        rightsConfirmed: true,
        ...result.fields, // status/printUrl/printStoragePath/previewUrl/previewStoragePath/sourceWidthPx/sourceHeightPx/validation
      };

      if (isReplace) {
        await replaceArtworkFile(replaceTarget, {
          ...fileFields,
          ...(label.trim() ? { label: label.trim() } : {}),
        });
        toast.success('Filen ersatt');
        onCreated?.();
        onClose?.();
        return;
      }

      const newId = await createArtwork({
        label: label.trim() || file.name,
        purpose: profile.id,
        ...fileFields,
        createdBy: auth.currentUser?.uid || null,
      }, shopId);
      toast.success('Tryckfil godkänd och sparad');
      setNotices(result.notices || []);
      onCreated?.();
      setCreatedArtworkId(newId);
      setSaving(false);
    } catch (err) {
      console.error('POD upload failed:', err);
      const msg = err?.message === 'internal'
        ? 'Filen kunde inte bearbetas på servern — försök igen om en stund.'
        : (err?.message || 'Uppladdningen misslyckades.');
      toast.error(msg);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface p-5 text-admin-text"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">
            {createdArtworkId ? 'Original sparat' : isReplace ? 'Ersätt fil' : 'Ladda upp original'}
          </h2>
          <button onClick={onClose} className="text-admin-text-faint hover:text-admin-text">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {createdArtworkId ? (
          <div className="space-y-4">
            {notices.length > 0 && (
              <ul className="space-y-1 rounded-[var(--radius-admin)] border border-admin-caution-dot/30 bg-admin-caution-bg px-3 py-2">
                {notices.map((n, i) => (
                  <li key={i} className="text-[12px] text-admin-caution-text">• {n.message}</li>
                ))}
              </ul>
            )}
            <p className="text-[13px] text-admin-text-muted">
              Originalet finns nu i biblioteket. Välj det i Designstudion; motiv och placering kopplas automatiskt till produkten när du publicerar.
            </p>
            {profile && ['poster_large', 'sticker_diecut', 'mug_wrap'].includes(profile.id) && (
              <p className="text-[12px] text-admin-text-faint">
                Originalets tryckprofil är <span className="font-medium">{profile.label}</span>. Välj en produkt som passar den profilen.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>Stäng</Button>
              {onUseInStudio && (
                <Button variant="primary" onClick={() => { onClose?.(); onUseInStudio(); }}>
                  Fortsätt till Designstudion
                </Button>
              )}
            </div>
          </div>
        ) : (
        <>
        {profiles.length === 0 ? (
          <p className="text-[13px] text-admin-text-muted">
            Inga tryckprofiler hittades. Be plattformen att köra seed-pod-profiles innan du laddar upp.
          </p>
        ) : (
          <div className="space-y-4">
            <Field label="Tryckändamål (profil)" htmlFor="pod-profile">
              <Select id="pod-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={isReplace}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </Select>
              {isReplace && (
                <p className="mt-1 text-[12px] text-admin-text-faint">Profilen är låst till originalets — endast filen byts ut.</p>
              )}
            </Field>

            <Field label="Namn (intern etikett)" htmlFor="pod-label">
              <Input id="pod-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="t.ex. Logotyp – framsida" />
            </Field>

            <Field label="Fil" htmlFor="pod-file" help={profile ? `Tillåtna: ${(profile.accepted_formats || []).map((f) => f.ext.toUpperCase()).join(', ')} · max ${profile.max_file_mb} MB · minst ${profile.min_dpi} DPI i största tryckstorlek` : ''}>
              <input id="pod-file" type="file" onChange={onPick} className="block w-full text-[13px] text-admin-text-muted file:mr-3 file:rounded-[var(--radius-admin-el)] file:border-0 file:bg-admin-surface-2 file:px-3 file:py-1.5 file:text-[13px] file:text-admin-text" />
            </Field>

            {/* Verdict — client pre-check (server rules at save) */}
            {file && (
              <div className="rounded-[var(--radius-admin)] border border-admin-border-soft bg-admin-surface-2 p-3">
                {measuring ? (
                  <p className="text-[13px] text-admin-text-muted">Analyserar filen…</p>
                ) : clientGate ? (
                  <>
                    <div className="mb-2 flex items-center gap-2">
                      <StatusPill tone={tierTone(blocked ? 'FAIL' : 'PASS')}>
                        {blocked ? tierLabel('FAIL') : dimsUnknown ? 'Kontrolleras vid uppladdning' : tierLabel('PASS')}
                      </StatusPill>
                      {clientGate.effectiveDpi != null && !blocked && (
                        <span className="text-[12px] text-admin-text-muted">{clientGate.effectiveDpi} DPI i största tryckstorlek</span>
                      )}
                      {measured?.widthPx && (
                        <span className="text-[12px] text-admin-text-faint">{measured.widthPx}×{measured.heightPx} px</span>
                      )}
                    </div>

                    {/* preview on checkerboard (light/white motifs stay visible) */}
                    {measured?.previewObjUrl && (
                      <div className="mb-2 inline-block rounded-[6px] border border-admin-border p-1" style={CHECKER_STYLE}>
                        <img src={measured.previewObjUrl} alt="" className="max-h-40 max-w-full object-contain" />
                      </div>
                    )}

                    {blocked ? (
                      <ul className="space-y-1">
                        {clientGate.reasons.map((r, i) => (
                          <li key={i} className="text-[12px] text-admin-critical-text">• {r.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <>
                        {dimsUnknown && (
                          <p className="text-[12px] text-admin-text-muted">
                            Måtten för .{normalizeExt(extOf(file.name)).toUpperCase()} läses på servern vid uppladdningen —
                            filen godkänns bara om den håller {profile?.min_dpi} DPI.
                          </p>
                        )}
                        {looksOpaque && (
                          <p className="mt-1 text-[12px] text-admin-caution-text">
                            Bilden saknar transparent bakgrund — hela rektangeln trycks, inklusive ev. vit bakgrund.
                            Är motivet en logga? Exportera som PNG med transparens.
                          </p>
                        )}
                        {duplicateOf && (
                          <p className="mt-1 text-[12px] text-admin-caution-text">
                            Samma fil finns redan i biblioteket som ”{duplicateOf.label || duplicateOf.fileName}”.
                          </p>
                        )}
                      </>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {/* Server rejection (authoritative) */}
            {serverReject && (
              <div className="rounded-[var(--radius-admin)] border border-admin-critical-dot/30 bg-admin-critical-bg p-3">
                <p className="mb-1 text-[12px] font-medium text-admin-critical-text">Filen godkändes inte:</p>
                <ul className="space-y-1">
                  {serverReject.map((r, i) => (
                    <li key={i} className="text-[12px] text-admin-critical-text">• {r.message}</li>
                  ))}
                </ul>
                <p className="mt-1 text-[12px] text-admin-text-faint">Välj en ny fil för att försöka igen.</p>
              </div>
            )}

            {isReplace && file && (
              <p className="rounded-[var(--radius-admin)] border border-admin-caution-dot/30 bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                Alla produkter som använder originalet får den nya filen — även ej skickade
                beställningar i print-kön.
              </p>
            )}

            {file && !blocked && (
              <label className="flex items-start gap-2 text-[12px] text-admin-text-muted">
                <input
                  type="checkbox"
                  checked={rightsOk}
                  onChange={(e) => setRightsOk(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Jag har rätt att använda detta motiv (upphovsrätt/varumärke).</span>
              </label>
            )}

            <details className="text-[12px] text-admin-text-faint">
              <summary className="cursor-pointer select-none">Tips för tryckfiler</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>PNG med transparent bakgrund ger friliggande motiv — JPG trycks alltid som en fylld rektangel.</li>
                <li>En fil = ett motiv. Ladda upp motivet i den riktning det ska tryckas.</li>
                <li>Tunna linjer under ~1 mm och mycket liten text trycks inte skarpt.</li>
                <li>Tryckta färger kan avvika något från skärmen — särskilt starka neonfärger.</li>
                <li>Skärmdumpar och webbloggor räcker sällan — be om originalfilen i full upplösning.</li>
              </ul>
            </details>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>Avbryt</Button>
              <Button variant="primary" onClick={handleSave} disabled={!file || saving || measuring || blocked || !rightsOk || !!serverReject}>
                {saving ? 'Bearbetar…' : isReplace ? 'Ersätt fil' : 'Spara original'}
              </Button>
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
};

// probeAlpha — pre-commit alpha + preview probe (client-side, instant feedback
// ONLY; the server re-derives alpha authoritatively on the converted PNG).
const probeAlpha = (file) =>
  new Promise((resolve) => {
    const ext = extOf(file.name);
    const raster = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
    if (!raster.has(ext)) {
      resolve({ hasAlphaChannel: undefined, transparentPixelRatio: undefined, previewObjUrl: null });
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        const scale = Math.min(1, 800 / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        const canHaveAlpha = ext === 'png' || ext === 'webp' || ext === 'gif';
        let hasAlphaChannel; let transparentPixelRatio;
        if (!canHaveAlpha) { hasAlphaChannel = false; transparentPixelRatio = 0; }
        else {
          try {
            const data = ctx.getImageData(0, 0, cw, ch).data;
            let t = 0; const total = cw * ch;
            for (let i = 3; i < data.length; i += 4) if (data[i] < 250) t++;
            transparentPixelRatio = total > 0 ? t / total : 0;
            hasAlphaChannel = true;
          } catch { hasAlphaChannel = undefined; transparentPixelRatio = undefined; }
        }
        resolve({ hasAlphaChannel, transparentPixelRatio, previewObjUrl: url });
      } catch {
        resolve({ hasAlphaChannel: undefined, transparentPixelRatio: undefined, previewObjUrl: null });
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ hasAlphaChannel: undefined, transparentPixelRatio: undefined, previewObjUrl: null }); };
    img.src = url;
  });

export default ArtworkUploadModal;
