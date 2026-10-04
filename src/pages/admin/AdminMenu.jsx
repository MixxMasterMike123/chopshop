// AdminMenu — the storefront top-navigation MENU BUILDER. The operator composes
// an ordered list of links from mixed sources (category / tag / collection / CMS
// page / custom URL / all-products / home). Saved as storeIdentity.menu (via
// saveShopConfig, same seam as AdminStorefront). When a shop has a menu, the
// storefront nav (ShopNavigation) renders it instead of the auto-category dedup;
// an empty menu falls back to today's behavior (backward-compat).
import React, { useState, useEffect, useMemo } from 'react';
import { useShopId } from '../../contexts/ShopContext';
import { loadMenuBuilder, saveMenu } from './adminMenuData';
import AppLayout from '../../components/layout/AppLayout';
import { Page, Card, CardSection, Button } from '../../components/admin/ui';
import { TrashIcon, PlusIcon } from '@heroicons/react/24/outline';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import toast from 'react-hot-toast';

const productName = (name) => {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name['sv-SE'] || Object.values(name).find((v) => typeof v === 'string') || '';
  return '';
};
const pageTitle = (t) => (typeof t === 'string' ? t : (t?.['sv-SE'] || Object.values(t || {}).find((v) => typeof v === 'string') || ''));

// The link types the operator can add. `home` and `all-products` need no target.
const TYPES = [
  { v: 'home', label: 'Hem', needsTarget: false },
  { v: 'all-products', label: 'Alla produkter', needsTarget: false },
  { v: 'collection', label: 'Samling', needsTarget: true },
  { v: 'category', label: 'Kategori', needsTarget: true },
  { v: 'tag', label: 'Tagg', needsTarget: true },
  { v: 'page', label: 'Sida', needsTarget: true },
  { v: 'url', label: 'Egen länk (URL)', needsTarget: true },
];

const SortableMenuRow = ({ item, index, sources, onChange, onRemove }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `menu-${index}` });
  const typeDef = TYPES.find((t) => t.v === item.type) || TYPES[0];

  // Target options depend on the type.
  const targetOptions =
    item.type === 'collection' ? sources.collections.map((c) => ({ v: c.handle, label: c.title || c.handle }))
    : item.type === 'category' ? sources.categories.map((c) => ({ v: c, label: c }))
    : item.type === 'tag' ? sources.tags.map((t) => ({ v: t, label: t }))
    : item.type === 'page' ? sources.pages.map((p) => ({ v: p.slug, label: `${p.title || p.slug}` }))
    : null;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }}
      className={`flex flex-wrap items-center gap-2 border-b border-admin-border-soft bg-admin-surface px-3 py-2.5 last:border-b-0 ${isDragging ? 'relative z-10 shadow-[var(--shadow-admin)]' : ''}`}
    >
      <span {...attributes} {...listeners} title="Dra för att ändra ordning" className="cursor-grab touch-none text-admin-text-faint active:cursor-grabbing">
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm8-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
        </svg>
      </span>

      {/* Type */}
      <select
        value={item.type}
        onChange={(e) => onChange(index, { ...item, type: e.target.value, target: '' })}
        className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1.5 text-[13px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
      >
        {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
      </select>

      {/* Target */}
      {typeDef.needsTarget && (
        item.type === 'url' ? (
          <input
            value={item.target || ''}
            onChange={(e) => onChange(index, { ...item, target: e.target.value })}
            placeholder="https://… (fullständig länk)"
            className="min-w-[10rem] flex-1 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
          />
        ) : (
          <select
            value={item.target || ''}
            onChange={(e) => onChange(index, { ...item, target: e.target.value })}
            className="min-w-[10rem] flex-1 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1.5 text-[13px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
          >
            <option value="">Välj…</option>
            {(targetOptions || []).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        )
      )}

      {/* Label */}
      <input
        value={item.label || ''}
        onChange={(e) => onChange(index, { ...item, label: e.target.value })}
        placeholder="Etikett i menyn"
        className="min-w-[8rem] flex-1 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
      />

      <button type="button" onClick={() => onRemove(index)} title="Ta bort" className="text-admin-text-faint hover:text-admin-critical-dot">
        <TrashIcon className="h-4 w-4" />
      </button>
    </div>
  );
};

const AdminMenu = () => {
  const shopId = useShopId();
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Sources for the target dropdowns.
  const [collections, setCollections] = useState([]);
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [pages, setPages] = useState([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const loaded = await loadMenuBuilder(shopId);
        if (cancelled) return;

        setMenu(loaded.menu);
        setCategories(loaded.categories);
        setTags(loaded.tags);
        setCollections(loaded.collections);
        setPages(loaded.pages);
      } catch (e) {
        console.error('Error loading menu builder:', e);
        toast.error('Kunde inte ladda menyn');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  const sources = useMemo(() => ({ collections, categories, tags, pages }), [collections, categories, tags, pages]);

  const addItem = () => setMenu((prev) => [...prev, { type: 'home', target: '', label: 'Hem' }]);
  const changeItem = (i, next) => setMenu((prev) => prev.map((m, idx) => (idx === i ? next : m)));
  const removeItem = (i) => setMenu((prev) => prev.filter((_, idx) => idx !== i));

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = Number(String(active.id).replace('menu-', ''));
    const to = Number(String(over.id).replace('menu-', ''));
    if (Number.isNaN(from) || Number.isNaN(to)) return;
    setMenu((prev) => arrayMove(prev, from, to));
  };

  const handleSave = async () => {
    // Validate: every item needs a label; target-requiring types need a target;
    // a custom 'url' must be absolute (http/https) — a relative path would route
    // off the shop (buildMenuHref passes it through, RRv6 treats /x as root).
    for (const m of menu) {
      const def = TYPES.find((t) => t.v === m.type);
      if (!m.label || !m.label.trim()) { toast.error('Alla menypunkter behöver en etikett.'); return; }
      if (def?.needsTarget && !m.target) { toast.error(`Menypunkten "${m.label}" saknar mål.`); return; }
      if (m.type === 'url' && !/^https?:\/\//i.test(m.target || '')) {
        toast.error(`Egen länk "${m.label}" måste börja med http:// eller https://`);
        return;
      }
    }
    try {
      setSaving(true);
      // Save the COMPLETE array — saveShopConfig merges storeIdentity, so it
      // replaces the whole menu key with what we send (never a partial patch).
      const clean = menu.map((m) => ({ type: m.type, target: m.target || '', label: m.label.trim() }));
      await saveMenu(clean, shopId);
      toast.success('Menyn sparad. Ladda om butiken för att se ändringarna.');
    } catch (e) {
      console.error('Error saving menu:', e);
      // Refused because the settings changed meanwhile (the admin build): the
      // menu shown follows what is stored, unless only other settings moved.
      if (Array.isArray(e?.menu)) setMenu(e.menu);
      toast.error(e?.userMessage || 'Kunde inte spara menyn', Array.isArray(e?.menu) ? { duration: 12000 } : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <Page
        title="Meny"
        actions={
          <>
            <Button variant="secondary" onClick={addItem} disabled={loading}>
              <PlusIcon className="h-4 w-4" /> Lägg till punkt
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={loading || saving}>
              {saving ? 'Sparar…' : 'Spara meny'}
            </Button>
          </>
        }
      >
        <Card className="mb-4 bg-admin-info-bg p-4">
          <p className="text-[13px] text-admin-info-text">
            Bygg butikens toppmeny. Varje punkt kan peka på en samling, kategori, tagg, sida eller egen länk.
            Utan meny visas kategorierna automatiskt (som idag).
          </p>
        </Card>

        {loading ? (
          <Card className="px-6 py-12 text-center">
            <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
          </Card>
        ) : (
          <CardSection title="Menypunkter" bodyClassName="p-0">
            {menu.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-admin-text-muted">
                Inga menypunkter ännu. Klicka "Lägg till punkt" för att börja bygga menyn.
              </p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={menu.map((_, i) => `menu-${i}`)} strategy={verticalListSortingStrategy}>
                  {menu.map((item, i) => (
                    <SortableMenuRow
                      key={`menu-${i}`}
                      item={item}
                      index={i}
                      sources={sources}
                      onChange={changeItem}
                      onRemove={removeItem}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </CardSection>
        )}
      </Page>
    </AppLayout>
  );
};

export default AdminMenu;
