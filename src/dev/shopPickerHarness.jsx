// shopPickerHarness.jsx — DEV-ONLY harness for eyeballing the admin ShopPicker
// (the screen that replaced the b8shield default fallback) WITHOUT Firebase.
// UNTRACKED: delete together with /shop-picker-harness.html.
//
// ShopPicker reads `shops` from Firestore directly, so this renders a visual
// TWIN: the same markup/tokens with fixture data, plus the loading/error/empty
// states, side by side in light and dark. Keep in sync with ShopPicker.jsx if
// that file's markup changes.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { BuildingStorefrontIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

const FIXTURE_SHOPS = [
  { id: 'melodie-mc', name: 'Melodie MC' },
  { id: 'ninetone', name: 'Ninetone' },
  { id: 'sillmans', name: 'Sillmans' },
  { id: 'gif-sundsvall', name: 'GIF Sundsvall' },
  { id: 'gamla-butiken', name: 'Gamla butiken', status: 'disabled' },
];

// Mirrors ShopPicker's markup exactly (fixture-driven state instead of Firestore).
const Picker = ({ shops = FIXTURE_SHOPS, loading = false, error = false }) => (
  <div className="min-h-screen bg-admin-bg px-4 py-12">
    <div className="mx-auto max-w-lg">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[var(--radius-admin)] bg-admin-surface text-admin-text-muted ring-1 ring-admin-border">
          <BuildingStorefrontIcon className="h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="text-[19px] font-semibold text-admin-text">Välj butik</h1>
        <p className="mt-1 text-[13px] text-admin-text-muted">
          Du är inloggad som plattformsadmin. Välj vilken butik du vill administrera.
        </p>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-admin)] bg-admin-surface ring-1 ring-admin-border">
        {loading && (
          <p className="px-4 py-8 text-center text-[13px] text-admin-text-muted">Laddar butiker…</p>
        )}
        {!loading && error && (
          <div className="flex items-start gap-3 px-4 py-6">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-admin-critical-dot" aria-hidden="true" />
            <p className="text-[13px] text-admin-text">
              Kunde inte hämta butikerna. Ladda om sidan och försök igen.
            </p>
          </div>
        )}
        {!loading && !error && shops.length === 0 && (
          <p className="px-4 py-8 text-center text-[13px] text-admin-text-muted">
            Inga butiker finns ännu. Skapa en i plattformskonsolen.
          </p>
        )}
        {!loading && !error && shops.map((shop, i) => (
          <button
            key={shop.id}
            className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-admin-surface-3 ${
              i > 0 ? 'border-t border-admin-border-soft' : ''
            }`}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-admin-el)] bg-admin-surface-2 text-[12px] font-semibold text-admin-text-muted">
              {(shop.name || shop.id).slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-admin-text">{shop.name || shop.id}</span>
              <span className="block truncate font-mono text-[11px] text-admin-text-faint">{shop.id}</span>
            </span>
            {shop.status === 'disabled' && (
              <span className="shrink-0 rounded-full bg-admin-neutral-bg px-2 py-0.5 text-[11px] font-medium text-admin-neutral-text">
                Pausad
              </span>
            )}
          </button>
        ))}
      </div>

      <p className="mt-4 text-center text-[12px] text-admin-text-faint">
        Valet sparas i den här webbläsaren. Du kan byta butik när som helst från butiksväljaren uppe till höger.
      </p>
    </div>
  </div>
);

// The project toggles dark mode with a `.dark` CLASS on <html> (see
// hooks/useDarkMode.js + the `.dark` block in index.css), NOT a data-theme
// attribute — so the pane wrapper must carry that class for the tokens to swap.
const Pane = ({ label, dark, children }) => (
  <div className={`${dark ? 'dark' : ''} flex-1 min-w-[420px]`}>
    <div className="bg-admin-surface-2 px-3 py-1 font-mono text-[11px] text-admin-text-faint">{label}</div>
    <div className="h-[420px] overflow-hidden">{children}</div>
  </div>
);

createRoot(document.getElementById('root')).render(
  <div>
    <div className="flex flex-wrap">
      <Pane label="LIGHT — populated"><Picker /></Pane>
      <Pane label="DARK — populated" dark><Picker /></Pane>
    </div>
    <div className="flex flex-wrap">
      <Pane label="LIGHT — loading"><Picker loading /></Pane>
      <Pane label="DARK — error" dark><Picker error /></Pane>
    </div>
    <div className="flex flex-wrap">
      <Pane label="LIGHT — empty"><Picker shops={[]} /></Pane>
      <Pane label="DARK — empty" dark><Picker shops={[]} /></Pane>
    </div>
  </div>
);
