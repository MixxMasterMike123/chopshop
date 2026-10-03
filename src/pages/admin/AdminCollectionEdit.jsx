// AdminCollectionEdit — create/edit a single collection. A collection is either
// MANUAL (hand-picked products, in pick order) or SMART (all products whose tags[]
// includes a chosen tag). It has a title/handle/description/image + published +
// featured (homepage "Populära samlingar"). Mirrors AdminPageEdit.jsx structure.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useShopId } from '../../contexts/ShopContext';
import { slugify, getCollectionUrl } from '../../utils/productUrls';
import { loadPickerProducts, loadCollection, handleIsTaken, uploadCollectionCover, saveCollection, deleteCollection } from './adminCollectionEditData';
import AppLayout from '../../components/layout/AppLayout';
import { Page, Card, CardSection, RightRail, Button, StatusPill, Field, Input, Textarea } from '../../components/admin/ui';
import { EyeIcon, TrashIcon, MagnifyingGlassIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';

// Read a product name that may be a legacy per-locale object or a plain string
// (same helper idiom as AdminProducts).
const productName = (name) => {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name['sv-SE'] || Object.values(name).find((v) => typeof v === 'string') || '';
  return '';
};

const emptyForm = {
  title: '',
  handle: '',
  description: '',
  imageUrl: '',
  type: 'manual',
  productIds: [],
  rule: { tag: '' },
  published: false,
  featured: false,
};

const AdminCollectionEdit = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const shopId = useShopId();
  const isNew = id === 'new';

  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [handleTouched, setHandleTouched] = useState(!isNew);

  // Shop products (for the manual picker) + tags (for the smart rule).
  const [products, setProducts] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  const [productSearch, setProductSearch] = useState('');

  const setField = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  // Load the shop's products + tags once (drives both pickers).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { products: data, availableTags: tags } = await loadPickerProducts(shopId);
        if (cancelled) return;
        setProducts(data);
        setAvailableTags(tags);
      } catch (e) {
        console.error('Error loading products for picker:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  // Load the collection (edit mode).
  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const d = await loadCollection(id);
        if (cancelled) return;
        if (!d) {
          toast.error('Samlingen kunde inte hittas');
          navigate('/admin/collections');
          return;
        }
        setForm({
          ...emptyForm,
          ...d,
          rule: d.rule || { tag: '' },
          productIds: Array.isArray(d.productIds) ? d.productIds : [],
        });
      } catch (e) {
        console.error('Error loading collection:', e);
        toast.error('Kunde inte ladda samlingen');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, isNew, navigate]);

  const onTitleChange = (e) => {
    const v = e.target.value;
    setForm((prev) => ({ ...prev, title: v, handle: handleTouched ? prev.handle : slugify(v) }));
  };

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Manual picker: chosen products (in pick order) + the searchable "add" list.
  const chosen = form.productIds.map((pid) => productById.get(pid)).filter(Boolean);
  const searchMatches = productSearch.trim()
    ? products
        .filter((p) => !form.productIds.includes(p.id))
        .filter((p) => productName(p.name).toLowerCase().includes(productSearch.trim().toLowerCase()) || (p.sku || '').toLowerCase().includes(productSearch.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  const addProduct = (pid) => { setField('productIds', [...form.productIds, pid]); setProductSearch(''); };
  const removeProduct = (pid) => setField('productIds', form.productIds.filter((x) => x !== pid));

  const handleImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Välj en bildfil.'); e.target.value = ''; return; }
    try {
      setUploading(true);
      const url = await uploadCollectionCover(file, shopId);
      setField('imageUrl', url);
      toast.success('Bild uppladdad');
    } catch (err) {
      console.error('Image upload failed:', err);
      toast.error(err?.userMessage || 'Kunde inte ladda upp bilden');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleSave = useCallback(async (publishedNext = form.published) => {
    const title = form.title.trim();
    const handle = (form.handle || slugify(title)).trim();
    if (!title) { toast.error('Titel är obligatorisk'); return; }
    if (!handle) { toast.error('Slug (handle) är obligatorisk'); return; }
    if (form.type === 'smart' && !form.rule?.tag) { toast.error('Välj en tagg för den smarta samlingen.'); return; }

    setSaving(true);
    try {
      // Handle must be unique within the shop — the storefront resolves a
      // collection by (shopId, handle) with limit(1), so a duplicate would make
      // one collection unreachable and render arbitrarily. Reject before writing.
      if (await handleIsTaken(shopId, handle, id)) {
        toast.error(`En annan samling använder redan slug "${handle}". Välj en unik slug.`);
        setSaving(false);
        return;
      }
      const data = {
        title,
        handle,
        description: form.description || '',
        imageUrl: form.imageUrl || '',
        type: form.type,
        // Persist BOTH shapes but only the active one carries data — keeps the
        // doc self-describing and lets an operator flip type without losing work.
        productIds: form.type === 'manual' ? form.productIds : [],
        rule: form.type === 'smart' ? { tag: form.rule.tag } : { tag: '' },
        published: publishedNext,
        featured: form.featured === true,
        sortOrder: Number.isFinite(form.sortOrder) ? form.sortOrder : null,
      };
      const savedId = await saveCollection({ id, isNew, shopId, data, form });
      if (isNew) {
        toast.success('Samlingen har skapats');
        navigate(`/admin/collections/${savedId}`);
      } else {
        toast.success('Samlingen har uppdaterats');
        setForm((prev) => ({ ...prev, published: publishedNext }));
      }
    } catch (e) {
      console.error('Error saving collection:', e);
      toast.error(e?.userMessage || 'Kunde inte spara samlingen');
    } finally {
      setSaving(false);
    }
  }, [form, id, isNew, navigate, shopId]);

  const handleDelete = async () => {
    if (isNew) return;
    if (!window.confirm('Ta bort denna samling? Åtgärden kan inte ångras.')) return;
    try {
      await deleteCollection(id);
      toast.success('Samlingen har tagits bort');
      navigate('/admin/collections');
    } catch (e) {
      console.error('Error deleting collection:', e);
      toast.error('Kunde inte ta bort samlingen');
    }
  };

  const smartCount = form.type === 'smart' && form.rule?.tag
    ? products.filter((p) => Array.isArray(p.tags) && p.tags.includes(form.rule.tag)).length
    : 0;

  if (loading) {
    return (
      <AppLayout>
        <Page title="Samling" back={{ to: '/admin/collections', label: 'Tillbaka till samlingar' }}>
          <Card className="px-6 py-12 text-center">
            <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
            <p className="mt-3 text-[13px] text-admin-text-muted">Laddar samling…</p>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  const headerActions = (
    <>
      {!isNew && form.published && (
        <Button as="a" href={getCollectionUrl(form.handle)} target="_blank" rel="noopener noreferrer" variant="secondary">
          <EyeIcon className="h-4 w-4" /> Visa
        </Button>
      )}
      <Button variant="secondary" onClick={() => handleSave(false)} disabled={saving}>Spara utkast</Button>
      <Button variant="primary" onClick={() => handleSave(true)} disabled={saving}>{form.published ? 'Uppdatera' : 'Publicera'}</Button>
    </>
  );

  return (
    <AppLayout>
      <Page
        title={isNew ? 'Ny samling' : form.title || 'Redigera samling'}
        subtitle={!isNew ? `/samling/${form.handle}` : undefined}
        titleAdornment={!isNew ? (
          <StatusPill tone={form.published ? 'success' : 'neutral'}>{form.published ? 'Publicerad' : 'Utkast'}</StatusPill>
        ) : undefined}
        back={{ to: '/admin/collections', label: 'Tillbaka till samlingar' }}
        actions={headerActions}
      >
        <RightRail
          main={
            <CardSection title="Samling" bodyClassName="space-y-4">
              <Field label="Titel" htmlFor="title" required>
                <Input id="title" value={form.title} onChange={onTitleChange} placeholder="t.ex. Eva Eastwood" />
              </Field>

              <Field label="Slug (handle)" htmlFor="handle" required help="URL: /samling/… — endast små bokstäver, siffror och bindestreck.">
                <Input
                  id="handle"
                  value={form.handle}
                  onChange={(e) => { setHandleTouched(true); setField('handle', slugify(e.target.value)); }}
                  placeholder="eva-eastwood"
                />
              </Field>

              <Field label="Beskrivning" htmlFor="description" help="Valfri text som visas på samlingssidan.">
                <Textarea id="description" rows={3} value={form.description} onChange={(e) => setField('description', e.target.value)} />
              </Field>

              {/* Type toggle */}
              <Field label="Typ av samling">
                <div className="flex gap-2">
                  {[
                    { v: 'manual', label: 'Manuell', desc: 'Välj produkter för hand' },
                    { v: 'smart', label: 'Smart', desc: 'Auto: alla produkter med en tagg' },
                  ].map((opt) => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => setField('type', opt.v)}
                      className={
                        'flex-1 rounded-[var(--radius-admin-el)] border px-3 py-2 text-left text-[13px] transition-colors ' +
                        (form.type === opt.v
                          ? 'border-[var(--color-admin-primary)] bg-admin-surface-2 text-admin-text'
                          : 'border-admin-border text-admin-text-muted hover:border-admin-text-faint')
                      }
                    >
                      <span className="block font-medium">{opt.label}</span>
                      <span className="block text-[12px] text-admin-text-faint">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </Field>

              {form.type === 'smart' ? (
                <Field label="Tagg" htmlFor="ruleTag" required help={form.rule?.tag ? `${smartCount} produkter matchar taggen "${form.rule.tag}".` : 'Alla produkter med den valda taggen ingår automatiskt.'}>
                  {availableTags.length === 0 ? (
                    <p className="text-[13px] text-admin-text-muted">Inga taggar finns ännu. Lägg till taggar på produkter först (Produkt → Organisation).</p>
                  ) : (
                    <select
                      id="ruleTag"
                      value={form.rule?.tag || ''}
                      onChange={(e) => setField('rule', { tag: e.target.value })}
                      className="w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 pr-8 text-[13px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                    >
                      <option value="">Välj tagg…</option>
                      {availableTags.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                </Field>
              ) : (
                <Field label="Produkter" help="Sök och lägg till produkter. Ordningen bestämmer visningsordningen på samlingssidan.">
                  <div className="relative">
                    <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-admin-text-faint" />
                    <input
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      placeholder="Sök produkt (namn eller SKU)…"
                      className="w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface py-1.5 pl-8 pr-3 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                    />
                    {searchMatches.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface shadow-[var(--shadow-admin)]">
                        {searchMatches.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => addProduct(p.id)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-admin-text hover:bg-admin-surface-2"
                          >
                            <PlusIcon className="h-3.5 w-3.5 text-admin-text-faint" />
                            <span className="truncate">{productName(p.name) || 'Namnlös'}</span>
                            {p.sku && <span className="ml-auto truncate text-[12px] text-admin-text-faint">{p.sku}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 space-y-1.5">
                    {chosen.length === 0 ? (
                      <p className="text-[13px] text-admin-text-faint">Inga produkter valda ännu.</p>
                    ) : (
                      chosen.map((p, i) => (
                        <div key={p.id} className="flex items-center gap-2 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1.5">
                          <span className="w-5 shrink-0 text-right text-[12px] tabular-nums text-admin-text-faint">{i + 1}</span>
                          {(p.imageUrl || p.b2cImageUrl) ? (
                            <img src={p.imageUrl || p.b2cImageUrl} alt="" className="h-7 w-7 shrink-0 rounded-[4px] border border-admin-border object-cover" />
                          ) : (
                            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-[4px] border border-admin-border bg-admin-surface-2 text-[10px] text-admin-text-faint">—</div>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[13px] text-admin-text">{productName(p.name) || 'Namnlös'}</span>
                          <button type="button" onClick={() => removeProduct(p.id)} title="Ta bort" className="text-admin-text-faint hover:text-admin-critical-dot">
                            <XMarkIcon className="h-4 w-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </Field>
              )}
            </CardSection>
          }
          rail={
            <>
              <CardSection title="Status" bodyClassName="space-y-3">
                <label className="flex items-center gap-2 text-[13px] text-admin-text">
                  <input type="checkbox" checked={form.published} onChange={(e) => setField('published', e.target.checked)} className="h-4 w-4 rounded border-admin-border" />
                  Publicerad
                </label>
                <label className="flex items-center gap-2 text-[13px] text-admin-text">
                  <input type="checkbox" checked={form.featured} onChange={(e) => setField('featured', e.target.checked)} className="h-4 w-4 rounded border-admin-border" />
                  Utvald (Populära samlingar på startsidan)
                </label>
                <p className="text-[12px] text-admin-text-muted">Utvalda samlingar visas som kort i "Populära samlingar" på startsidan. Publicerade samlingar går att länka i menyn.</p>
              </CardSection>

              <CardSection title="Bild" bodyClassName="space-y-3">
                {form.imageUrl ? (
                  <div className="relative">
                    <img src={form.imageUrl} alt="" className="aspect-[4/5] w-full rounded-[var(--radius-admin-el)] border border-admin-border object-cover" />
                    <button
                      type="button"
                      onClick={() => setField('imageUrl', '')}
                      title="Ta bort bild"
                      className="absolute right-2 top-2 rounded-full bg-black/50 p-1 text-white hover:bg-black/70"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <p className="text-[12px] text-admin-text-muted">Ingen bild vald. Visas på samlingskortet på startsidan.</p>
                )}
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text hover:bg-admin-surface-2">
                  {uploading ? 'Laddar upp…' : (form.imageUrl ? 'Byt bild' : 'Ladda upp bild')}
                  <input type="file" accept="image/*" onChange={handleImage} disabled={uploading} className="hidden" />
                </label>
              </CardSection>

              {!isNew && (
                <CardSection title="Fara" bodyClassName="space-y-2">
                  <Button variant="secondary" onClick={handleDelete} className="w-full text-admin-critical-text">
                    <TrashIcon className="h-4 w-4" /> Ta bort samling
                  </Button>
                </CardSection>
              )}
            </>
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminCollectionEdit;
