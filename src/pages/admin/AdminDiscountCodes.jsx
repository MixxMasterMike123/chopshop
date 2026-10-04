import React, { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
// The page's data, one module per build (CP8-DC): Firebase in the older
// build, the API in the admin build (vite.admin.config.js ADMIN_ALIASES).
import {
  SUPPORTS_DELETE,
  deleteDiscountCode,
  fmtDate,
  inputToDate,
  loadDiscountCodes,
  loadDiscountProducts,
  normalizeCode,
  saveDiscountCode,
  setDiscountCodeActive,
  tsToInput,
} from './adminDiscountCodesData';
import {
  Page,
  MetricsBar,
  DataTable,
  StatusPill,
  Button,
  Field,
  Input,
  Select,
} from '../../components/admin/ui';
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline';

// Empty create/edit form. Mirrors the discountCodes data model. Dates are held
// as YYYY-MM-DD strings for the <input type="date"> and converted to Timestamps
// (or null) on write.
const emptyForm = () => ({
  code: '',
  type: 'percent',
  value: 10,
  scope: 'all',
  productIds: [],
  minSpend: '',
  startsAt: '',
  endsAt: '',
  maxUses: '',
  active: true,
});

const AdminDiscountCodes = () => {
  const shopId = useShopId();
  const [codes, setCodes] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const fetchData = async () => {
    setLoading(true);
    try {
      setCodes(await loadDiscountCodes(shopId));
      // Products for the scope='products' picker.
      setProducts(await loadDiscountProducts(shopId));
    } catch (error) {
      console.error('Error fetching discount codes:', error);
      toast.error('Kunde inte hämta rabattkoder.');
    } finally {
      setLoading(false);
    }
  };

  const stats = useMemo(() => {
    const active = codes.filter((c) => c.active !== false).length;
    const totalUses = codes.reduce((sum, c) => sum + (c.usedCount || 0), 0);
    return { total: codes.length, active, totalUses };
  }, [codes]);

  const metrics = [
    { key: 'total', label: 'Antal koder', value: stats.total },
    { key: 'active', label: 'Aktiva koder', value: stats.active },
    { key: 'uses', label: 'Totalt använda', value: stats.totalUses.toLocaleString('sv-SE') },
  ];

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setModalOpen(true);
  };

  const openEdit = (c) => {
    setEditingId(c.id);
    setForm({
      code: c.code || '',
      type: c.type || 'percent',
      value: c.value ?? 0,
      scope: c.scope || 'all',
      productIds: Array.isArray(c.productIds) ? c.productIds : [],
      minSpend: c.minSpend != null ? String(c.minSpend) : '',
      startsAt: tsToInput(c.startsAt),
      endsAt: tsToInput(c.endsAt),
      maxUses: c.maxUses != null ? String(c.maxUses) : '',
      active: c.active !== false,
    });
    setModalOpen(true);
  };

  const toggleProduct = (productId) => {
    setForm((prev) => ({
      ...prev,
      productIds: prev.productIds.includes(productId)
        ? prev.productIds.filter((id) => id !== productId)
        : [...prev.productIds, productId],
    }));
  };

  const handleSave = async () => {
    // Codes are normalized UPPERCASE (trimmed) — matches the server lookup +
    // affiliate convention, so a lowercase entry still validates at checkout.
    const normalizedCode = normalizeCode(form.code);
    if (!normalizedCode) {
      toast.error('Ange en kod.');
      return;
    }
    // A code with a space in it cannot be told to a buyer (the server refuses it).
    if (/[\s\u0000-\u001f\u007f-\u009f]/.test(normalizedCode)) {
      toast.error('Koden får inte innehålla mellanslag.');
      return;
    }
    const value = Number(form.value);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Ange ett giltigt rabattvärde.');
      return;
    }
    if (form.type === 'percent' && value > 100) {
      toast.error('Procentrabatt kan inte överstiga 100 %.');
      return;
    }
    if (form.scope === 'products' && form.productIds.length === 0) {
      toast.error('Välj minst en produkt när koden gäller valda produkter.');
      return;
    }
    const maxUses = form.maxUses === '' ? null : Math.max(1, Math.floor(Number(form.maxUses)));
    if (form.maxUses !== '' && (!Number.isFinite(maxUses) || maxUses < 1)) {
      toast.error('Användningsgräns måste vara ett positivt heltal.');
      return;
    }
    const minSpend = form.minSpend === '' ? null : Math.max(0, Math.floor(Number(form.minSpend)));
    if (form.minSpend !== '' && (!Number.isFinite(minSpend) || minSpend < 0)) {
      toast.error('Lägsta ordervärde måste vara ett positivt tal.');
      return;
    }
    const startsAt = inputToDate(form.startsAt);
    const endsAt = inputToDate(form.endsAt);
    if (startsAt && endsAt && startsAt > endsAt) {
      toast.error('Startdatum måste vara före slutdatum.');
      return;
    }

    setSaving(true);
    const toastId = toast.loading(editingId ? 'Sparar…' : 'Skapar kod…');
    try {
      await saveDiscountCode({
        shopId,
        id: editingId,
        form: {
          code: normalizedCode,
          type: form.type,
          value,
          scope: form.scope,
          productIds: form.productIds,
          minSpend,
          startsDay: form.startsAt,
          endsDay: form.endsAt,
          maxUses,
          active: !!form.active,
        },
      });
      toast.success(editingId ? 'Rabattkod uppdaterad.' : 'Rabattkod skapad.', { id: toastId });
      setModalOpen(false);
      fetchData();
    } catch (error) {
      if (error?.code === 'conflict') {
        toast.error('En kod med detta namn finns redan.', { id: toastId });
      } else if (error?.code === 'discount_code_in_use') {
        toast.error('Koden har redan använts och kan inte byta namn. Skapa en ny kod i stället.', { id: toastId });
      } else {
        console.error('Error saving discount code:', error);
        toast.error('Kunde inte spara rabattkoden.', { id: toastId });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (c) => {
    try {
      await setDiscountCodeActive(shopId, c, !(c.active !== false));
      setCodes((prev) =>
        prev.map((x) => (x.id === c.id ? { ...x, active: !(c.active !== false) } : x))
      );
    } catch (error) {
      console.error('Error toggling code:', error);
      toast.error('Kunde inte ändra status.');
    }
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Radera rabattkoden "${c.code}"?`)) return;
    const toastId = toast.loading('Raderar…');
    try {
      await deleteDiscountCode(shopId, c);
      toast.success('Rabattkod raderad.', { id: toastId });
      setCodes((prev) => prev.filter((x) => x.id !== c.id));
    } catch (error) {
      console.error('Error deleting code:', error);
      toast.error('Kunde inte radera koden.', { id: toastId });
    }
  };

  const columns = [
    {
      key: 'code',
      header: 'Kod',
      render: (c) => (
        <span className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-2 py-0.5 font-mono text-[12px] text-admin-text">
          {c.code}
        </span>
      ),
    },
    {
      key: 'value',
      header: 'Rabatt',
      render: (c) => (
        <span className="text-admin-text">
          {c.type === 'percent' ? `${c.value} %` : `${c.value} kr`}
        </span>
      ),
    },
    {
      key: 'scope',
      header: 'Gäller',
      render: (c) => (
        <span className="text-admin-text-muted">
          {c.scope === 'products'
            ? `${(c.productIds || []).length} produkter`
            : 'Hela kundvagnen'}
          {c.minSpend != null && (
            <span className="block text-[12px] text-admin-text-faint">
              från {c.minSpend} kr
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'window',
      header: 'Period',
      render: (c) => (
        <span className="text-[12px] text-admin-text-muted">
          {fmtDate(c.startsAt) || '—'} → {fmtDate(c.endsAt) || '∞'}
        </span>
      ),
    },
    {
      key: 'uses',
      header: 'Använt',
      align: 'right',
      render: (c) => (
        <span className="tabular-nums text-admin-text-muted">
          {(c.usedCount || 0).toLocaleString('sv-SE')}
          {c.maxUses != null ? ` / ${c.maxUses}` : ''}
          {c.heldCount > 0 && (
            <span className="block text-[12px] text-admin-text-faint">
              ({c.heldCount.toLocaleString('sv-SE')} i kassan)
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleToggleActive(c); }}>
          <StatusPill tone={c.active !== false ? 'success' : 'neutral'}>
            {c.active !== false ? 'Aktiv' : 'Inaktiv'}
          </StatusPill>
        </button>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-24',
      render: (c) => (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => openEdit(c)}
            title="Redigera"
            aria-label="Redigera"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-text"
          >
            <PencilIcon className="h-4 w-4" />
          </button>
          {/* The admin build has no delete: a code is deactivated (CP8-DC). */}
          {SUPPORTS_DELETE && (
            <button
              type="button"
              onClick={() => handleDelete(c)}
              title="Radera"
              aria-label="Radera"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-red-600"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  const headerActions = (
    <Button variant="primary" onClick={openCreate}>
      Skapa rabattkod
    </Button>
  );

  return (
    <AppLayout>
      <Page
        title="Rabattkoder"
        subtitle="Skapa kampanjkoder med rabatt på hela kundvagnen eller valda produkter."
        actions={headerActions}
      >
        <div className="space-y-5">
          <MetricsBar metrics={metrics} />
          <DataTable
            columns={columns}
            rows={codes}
            rowKey={(c) => c.id}
            loading={loading}
            onRowClick={(c) => openEdit(c)}
            empty="Inga rabattkoder ännu. Skapa din första kampanjkod."
          />
        </div>
      </Page>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="mt-8 w-full max-w-lg rounded-[var(--radius-admin-card)] bg-admin-surface p-5 shadow-xl">
            <h2 className="mb-4 text-[15px] font-semibold text-admin-text">
              {editingId ? 'Redigera rabattkod' : 'Skapa rabattkod'}
            </h2>

            <div className="space-y-4">
              <Field label="Kod" required help="Skrivs alltid med versaler. T.ex. SOMMAR20">
                <Input
                  value={form.code}
                  onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
                  placeholder="SOMMAR20"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Typ" required>
                  <Select
                    value={form.type}
                    onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))}
                  >
                    <option value="percent">Procent (%)</option>
                    <option value="fixed">Fast belopp (kr)</option>
                  </Select>
                </Field>
                <Field label={form.type === 'percent' ? 'Rabatt (%)' : 'Rabatt (kr)'} required>
                  <Input
                    type="number"
                    min="0"
                    max={form.type === 'percent' ? '100' : undefined}
                    value={form.value}
                    onChange={(e) => setForm((p) => ({ ...p, value: e.target.value }))}
                  />
                </Field>
              </div>

              <Field label="Gäller">
                <Select
                  value={form.scope}
                  onChange={(e) => setForm((p) => ({ ...p, scope: e.target.value }))}
                >
                  <option value="all">Hela kundvagnen</option>
                  <option value="products">Valda produkter</option>
                </Select>
              </Field>

              {form.scope === 'products' && (
                <div className="max-h-56 overflow-y-auto rounded-[var(--radius-admin-el)] border border-admin-border p-2">
                  {products.length === 0 ? (
                    <div className="p-2 text-center text-[13px] text-admin-text-muted">
                      Inga aktiva produkter.
                    </div>
                  ) : (
                    products.map((p) => (
                      <label
                        key={p.id}
                        className="flex items-center gap-2 rounded-[var(--radius-admin-el)] p-1.5 hover:bg-admin-surface-2"
                      >
                        <input
                          type="checkbox"
                          checked={form.productIds.includes(p.id)}
                          onChange={() => toggleProduct(p.id)}
                          className="h-4 w-4"
                        />
                        <span className="text-[13px] text-admin-text">
                          {typeof p.name === 'string' ? p.name : p.name?.['sv-SE'] || p.sku || 'Produkt'}
                        </span>
                        <span className="ml-auto font-mono text-[11px] text-admin-text-faint">{p.sku}</span>
                      </label>
                    ))
                  )}
                </div>
              )}

              <Field
                label="Lägsta ordervärde (kr)"
                help="Valfritt. Koden gäller endast om delsumman är minst detta belopp."
              >
                <Input
                  type="number"
                  min="0"
                  value={form.minSpend}
                  onChange={(e) => setForm((p) => ({ ...p, minSpend: e.target.value }))}
                  placeholder="Inget krav"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Startdatum" help="Valfritt.">
                  <Input
                    type="date"
                    value={form.startsAt}
                    onChange={(e) => setForm((p) => ({ ...p, startsAt: e.target.value }))}
                  />
                </Field>
                <Field label="Slutdatum" help="Valfritt. Koden gäller till och med detta datum.">
                  <Input
                    type="date"
                    value={form.endsAt}
                    onChange={(e) => setForm((p) => ({ ...p, endsAt: e.target.value }))}
                  />
                </Field>
              </div>

              <Field
                label="Användningsgräns"
                help="Valfritt. Max antal gånger koden kan användas totalt."
              >
                <Input
                  type="number"
                  min="1"
                  value={form.maxUses}
                  onChange={(e) => setForm((p) => ({ ...p, maxUses: e.target.value }))}
                  placeholder="Obegränsat"
                />
              </Field>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))}
                  className="h-4 w-4"
                />
                <span className="text-[13px] text-admin-text">Aktiv</span>
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
                Avbryt
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Sparar…' : editingId ? 'Spara' : 'Skapa'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
};

export default AdminDiscountCodes;
