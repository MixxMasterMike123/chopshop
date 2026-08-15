// PodAdminPage — the admin surface for the Print on Demand add-on.
//
// Two sections, switched by a simple tab:
//   • Original (Slice 3): the artwork library — upload + validate print files.
//   • Produktkoppling (Slice 4): map a validated artwork → product SKU + placement.
//
// Design: wraps <AppLayout> (REQUIRED — an admin page without it loses the menu)
// on the Admin-Neutral design system (Page / CardSection / Button + admin-* tokens).
//
// Gating: the route is already wrapped in <AddonGate feature="pod"> + <AdminRoute>
// (App.jsx), so reaching here implies the shop is entitled. We still read
// useShopFeatures() defensively and useShopId() to scope all data to the shop.
import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import AppLayout from '../../../components/layout/AppLayout';
import { Page, CardSection, Button } from '../../../components/admin/ui';
import { useShopId } from '../../../contexts/ShopContext';
import { useShopFeatures } from '../../../contexts/ShopFeaturesContext';
import ArtworkLibrary from './ArtworkLibrary';
import ProductMapping from './ProductMapping';
import DesignStudio from '../studio/DesignStudio';
import usePodLibrary from './usePodLibrary';

// Provisional-spec banner: the seeded print profiles are industry-typical
// PLACEHOLDERS until the real print shop delivers its specs. Surfaced here and in
// the upload modal so a seller never treats a PASS as a guarantee.
const ProvisionalBanner = () => (
  <div className="mb-4 rounded-[var(--radius-admin)] border border-admin-caution-dot/30 bg-admin-caution-bg px-4 py-3 text-[13px] text-admin-caution-text">
    <span className="font-semibold">Preliminära trycksparametrar.</span>{' '}
    Specarna nedan är branschtypiska platshållare och valideringen är{' '}
    <span className="font-semibold">vägledande</span> — verifiera alltid med tryckeriet
    innan produktion.
  </div>
);

const TABS = [
  { key: 'library', label: 'Original' },
  { key: 'mapping', label: 'Produktkoppling' },
  { key: 'studio', label: 'Studio' },
];

// UnmappedBanner — LOUD page-level alert (visible on ANY tab). An unmapped original
// means orders for it never reach the print queue, so this must be impossible to
// miss. Reuses the provisional-banner amber pattern. Hidden when count is 0.
const UnmappedBanner = ({ count, onFix }) => {
  if (!count) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-admin)] border border-admin-caution-dot/30 bg-admin-caution-bg px-4 py-3 text-[13px] text-admin-caution-text">
      <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{count} original</span> är inte kopplade till någon
        produkt — de skickas <span className="font-semibold">ALDRIG</span> till tryckeriet
        förrän de kopplas.
      </span>
      <Button variant="secondary" onClick={onFix}>Koppla nu</Button>
    </div>
  );
};

const PodAdminPage = () => {
  const shopId = useShopId();
  const { isEnabled } = useShopFeatures();
  // Deep link from the product form (way 2): /admin/pod?designFor=<productId>
  // opens the STUDIO tab with that product preselected as publish target.
  const [searchParams] = useSearchParams();
  const designForProductId = searchParams.get('designFor') || null;
  const [tab, setTab] = useState(designForProductId ? 'studio' : 'library');
  // When set, the mapping tab preselects this original in its add-row.
  const [prefillArtworkId, setPrefillArtworkId] = useState(null);

  // ONE shared load for the banner + both tabs (no per-tab duplicate reads).
  const lib = usePodLibrary(shopId);

  const jumpToMapping = (artworkId = null) => {
    setPrefillArtworkId(artworkId);
    setTab('mapping');
  };

  // Defensive: the route guard already blocks a non-entitled shop, but never
  // render the tooling if the add-on is off (belt-and-suspenders).
  if (!isEnabled('pod')) {
    return (
      <AppLayout>
        <Page title="Print on demand">
          <CardSection>
            <p className="text-[13px] text-admin-text-muted">
              Print on demand-tillägget är inte aktiverat för den här butiken.
            </p>
          </CardSection>
        </Page>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Page title="Print on demand">
        <ProvisionalBanner />

        <UnmappedBanner count={lib.unmappedArtwork.length} onFix={() => jumpToMapping(null)} />

        {/* Tab switch */}
        <div className="mb-4 flex gap-1">
          {TABS.map((tDef) => {
            const active = tab === tDef.key;
            return (
              <button
                key={tDef.key}
                type="button"
                onClick={() => setTab(tDef.key)}
                className={`rounded-[var(--radius-admin-el)] px-3 py-1.5 text-[13px] ${
                  active
                    ? 'bg-black/[0.08] font-semibold text-admin-text'
                    : 'font-medium text-admin-text-muted hover:bg-black/[0.06]'
                }`}
              >
                {tDef.label}
              </button>
            );
          })}
        </div>

        {tab === 'library' && (
          <ArtworkLibrary
            shopId={shopId}
            artwork={lib.artwork}
            profiles={lib.profiles}
            products={lib.products}
            mappings={lib.mappings}
            mappedArtworkIds={lib.mappedArtworkIds}
            loading={lib.loading}
            onChanged={lib.refresh}
            onMapArtwork={(artworkId) => jumpToMapping(artworkId)}
          />
        )}
        {tab === 'mapping' && (
          <ProductMapping
            shopId={shopId}
            mappings={lib.mappings}
            artwork={lib.artwork}
            profiles={lib.profiles}
            products={lib.products}
            productSkus={lib.productSkus}
            loading={lib.loading}
            onChanged={lib.refresh}
            prefillArtworkId={prefillArtworkId}
          />
        )}
        {/* The studio stays MOUNTED across tab switches (hidden with CSS, not
            unmounted): its whole design state (prints/placements/mockups/
            publish form) is component state, and the studio's own empty-state
            advice sends users to the Original tab mid-design — unmounting
            would silently destroy their work (critique P0, 2026-08-08). */}
        <div className={tab === 'studio' ? '' : 'hidden'}>
          {/* GATE (docs/POD_PRINT_SPEC.md): only artwork the server pipeline
              approved (status 'ready') may be designed with. Legacy/rejected
              stays visible in the library with a "Validera om" action. */}
          <DesignStudio
            artwork={lib.artwork.filter((a) => a.status === 'ready')}
            loading={lib.loading}
            shopId={shopId}
            products={lib.products}
            onChanged={lib.refresh}
            onOpenArtworkLibrary={() => setTab('library')}
            designForProductId={designForProductId}
          />
        </div>
      </Page>
    </AppLayout>
  );
};

export default PodAdminPage;
