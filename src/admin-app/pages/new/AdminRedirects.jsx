// Admin → Omdirigeringar (unit CP5-FL): the shop's own forwards from old
// addresses to new ones (D88; the Worker's /v1/admin/redirects). List (a page
// at a time), add, remove. The server stores each address in one normal
// form and refuses what cannot be forwarded; its refusal is shown as a
// Swedish sentence at the form. Every call is bound to the shop the page was
// opened for (redirectsData.js); the page is locked while a write runs, and a
// lost answer is read back before the page says anything.
// Admin-Neutral, inside AppLayout. New page of the admin build: no older page.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowRightIcon, TrashIcon } from '@heroicons/react/24/outline';
import AppLayout from '../../../components/layout/AppLayout';
import { Button, CardSection, DataTable, Field, Input, Page } from '../../../components/admin/ui';
import { compareUtf8, dateText } from '../../adapters/redirects.js';
import { storefrontUrl } from '../../adapters/storefrontLinks.js';
import { useShopId } from '../../providers/ActiveShop.jsx';
import { APP_URLS } from '../../replacements/urls.js';
import { loadForwards, removeForward, saveForward } from './redirectsData.js';

const EXAMPLE_PATH = '/products/gammal-troja';

/** The loaded rows with `row` put in its place (the list's order), or left out when it sorts past what is loaded. */
function placed(rows, row, more) {
  const rest = rows.filter((r) => r.fromPath !== row.fromPath);
  const last = rest.at(-1);
  if (more && last && compareUtf8(row.fromPath, last.fromPath) > 0) return rest;
  const at = rest.findIndex((r) => compareUtf8(r.fromPath, row.fromPath) > 0);
  return at === -1 ? [...rest, row] : [...rest.slice(0, at), row, ...rest.slice(at)];
}

export default function AdminRedirects() {
  const shopId = useShopId();
  const [rows, setRows] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [fromPath, setFromPath] = useState('');
  const [toPath, setToPath] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false); // a write runs: the form and every remove are locked
  const [removing, setRemoving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const page = await loadForwards(shopId);
      setRows(page.redirects);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setLoadError(e.userMessage || 'Omdirigeringarna kunde inte läsas.');
    } finally {
      setLoading(false);
    }
  }, [shopId]);
  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadForwards(shopId, nextCursor);
      setRows((r) => [...r, ...page.redirects.filter((n) => !r.some((o) => o.fromPath === n.fromPath))]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      toast.error(e.userMessage || 'Fler omdirigeringar kunde inte läsas.');
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError('');
    try {
      const { forward } = await saveForward(shopId, { fromPath, toPath });
      setRows((r) => placed(r, forward, Boolean(nextCursor)));
      setFromPath('');
      setToPath('');
      toast.success(`Sparad: ${forward.fromPath} skickas till ${forward.toPath}.`);
    } catch (err) {
      setFormError(err.userMessage || 'Omdirigeringen kunde inte sparas.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row) => {
    if (busy) return;
    if (!window.confirm(`Ta bort omdirigeringen från ${row.fromPath}? Den som går till den gamla adressen får då sidan "hittades inte".`)) return;
    setBusy(true);
    setRemoving(row.fromPath);
    try {
      await removeForward(shopId, row.fromPath);
      setRows((r) => r.filter((x) => x.fromPath !== row.fromPath));
      toast.success('Omdirigeringen är borttagen.');
    } catch (err) {
      toast.error(err.userMessage || 'Omdirigeringen kunde inte tas bort.', { duration: 8000 });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const example = storefrontUrl(APP_URLS.B2C_SHOP, shopId, EXAMPLE_PATH);

  const columns = [
    {
      key: 'from',
      header: 'Gammal adress',
      render: (r) => <span className="block break-all font-mono text-[12px] text-admin-text">{r.fromPath}</span>,
    },
    {
      key: 'arrow',
      header: <span className="sr-only">skickas till</span>,
      className: 'w-6',
      render: () => <ArrowRightIcon className="h-4 w-4 text-admin-text-faint" aria-hidden="true" />,
    },
    {
      key: 'to',
      header: 'Ny adress',
      render: (r) => <span className="block break-all font-mono text-[12px] text-admin-text-muted">{r.toPath}</span>,
    },
    {
      key: 'created',
      header: 'Sparad',
      className: 'hidden whitespace-nowrap sm:table-cell',
      render: (r) => <span className="text-admin-text-muted">{dateText(r.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-12',
      render: (r) => (
        <button
          type="button"
          onClick={() => remove(r)}
          disabled={busy}
          title="Ta bort omdirigeringen"
          aria-label={`Ta bort omdirigeringen från ${r.fromPath}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {removing === r.fromPath ? <span className="text-[12px]">…</span> : <TrashIcon className="h-4 w-4" />}
        </button>
      ),
    },
  ];

  return (
    <AppLayout>
      <Page
        title="Omdirigeringar"
        subtitle="Skicka besökare och sökmotorer från gamla adresser till nya, till exempel efter en flytt från en annan butiksplattform."
      >
        <div className="space-y-3">
          <CardSection title="Ny omdirigering">
            <form onSubmit={submit} className="space-y-3">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
                <Field label="Gammal adress" htmlFor="fl-from">
                  <Input
                    id="fl-from"
                    value={fromPath}
                    onChange={(e) => { setFromPath(e.target.value); setFormError(''); }}
                    disabled={busy}
                    placeholder={EXAMPLE_PATH}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
                <Field label="Ny adress" htmlFor="fl-to">
                  <Input
                    id="fl-to"
                    value={toPath}
                    onChange={(e) => { setToPath(e.target.value); setFormError(''); }}
                    disabled={busy}
                    placeholder="/product/ny-troja"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
                <Button variant="primary" type="submit" disabled={busy} className="md:mb-px">
                  {busy && !removing ? 'Sparar…' : 'Lägg till'}
                </Button>
              </div>
              {formError && (
                <p role="alert" className="rounded-[var(--radius-admin-el)] bg-admin-critical-bg px-3 py-2 text-[13px] text-admin-critical-text">
                  {formError}
                </p>
              )}
              <p className="text-[12px] leading-5 text-admin-text-muted">
                Skriv det som kommer efter butikens adress, med / först
                {example ? <>: <span className="font-mono">{EXAMPLE_PATH}</span> gäller <span className="break-all font-mono">{example}</span>.</> : '.'}{' '}
                Besökare skickas vidare permanent (301), och sökmotorer flyttar över adressens ranking. Finns den gamla adressen redan, får den den nya adressen som mål.
              </p>
            </form>
          </CardSection>

          {loadError ? (
            <CardSection>
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[13px] text-admin-critical-text">{loadError}</p>
                <Button onClick={load}>Försök igen</Button>
              </div>
            </CardSection>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.fromPath}
              loading={loading}
              empty="Inga omdirigeringar ännu. Lägg till en ovan när en gammal adress ska leda till en ny sida."
              footer={nextCursor ? (
                <div className="flex justify-center p-2">
                  <Button variant="plain" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? 'Läser…' : 'Visa fler'}
                  </Button>
                </div>
              ) : null}
            />
          )}

          <p className="text-[12px] text-admin-text-faint">
            Omdirigeringarna gäller när butiken är publicerad. Butikens egna sidor för varukorg, kassa, order, ångerrätt och intrångsanmälan kan inte omdirigeras.
          </p>
        </div>
      </Page>
    </AppLayout>
  );
}
