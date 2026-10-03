// AdminCollections — the COLLECTIONS list for a shop. Collections are curated
// product groups (manual pick or smart tag-rule) that drive storefront collection
// pages, the homepage "Populära samlingar" cards, and menu links. Create/edit
// lives in AdminCollectionEdit.jsx. This page owns: load (shop-scoped), the list
// table, open/edit/delete, the featured star (homepage "Populära samlingar"), and
// the drag-sort mode (persists per-collection sortOrder). Mirrors AdminProducts.jsx.
import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loadShopCollections, deleteShopCollection, setCollectionFeatured, saveCollectionOrder } from './adminCollectionsData';
import { useAuth } from '../../contexts/AuthContext';
import { useShopId } from '../../contexts/ShopContext';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import { Page, DataTable, StatusPill, Button } from '../../components/admin/ui';
import { TrashIcon, StarIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Collections carry an explicit `sortOrder` (assigned in drag-sort). Order the
// list by sortOrder-first, then title — mirrors sortProductsForDisplay's rule
// but collections have no legacy fallback, so it's a small local comparator.
const compareCollections = (a, b) => {
  const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.POSITIVE_INFINITY;
  const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return (a.title || '').localeCompare(b.title || '', 'sv');
};

const isCollectionFeatured = (c) => c.featured === true;

// One draggable row in sort mode (grip-only listeners, same idiom as AdminProducts).
const SortableCollectionRow = ({ item, position }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }}
      className={`flex items-center gap-3 border-b border-admin-border-soft bg-admin-surface px-3 py-2 last:border-b-0 ${isDragging ? 'relative z-10 shadow-[var(--shadow-admin)]' : ''}`}
    >
      <span
        {...attributes}
        {...listeners}
        title="Dra för att ändra ordning"
        className="cursor-grab touch-none text-admin-text-faint active:cursor-grabbing"
      >
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm8-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
        </svg>
      </span>
      <span className="w-6 shrink-0 text-right text-[12px] tabular-nums text-admin-text-faint">{position}</span>
      {item.imageUrl ? (
        <img src={item.imageUrl} alt="" className="h-9 w-9 shrink-0 rounded-[6px] border border-admin-border object-cover" />
      ) : (
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[6px] border border-admin-border bg-admin-surface-2 text-[10px] text-admin-text-faint">—</div>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-admin-text">{item.title || 'Namnlös'}</span>
        <span className="block truncate text-[12px] text-admin-text-faint">{item.type === 'smart' ? 'Smart' : 'Manuell'}</span>
      </span>
      {isCollectionFeatured(item) && (
        <span title="Utvald på startsidan" className="shrink-0"><StarSolidIcon className="h-4 w-4 text-amber-400" /></span>
      )}
      {!item.published && <StatusPill tone="neutral">Utkast</StatusPill>}
    </div>
  );
};

const AdminCollections = () => {
  const { isAdmin } = useAuth();
  const shopId = useShopId();
  const navigate = useNavigate();

  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sortMode, setSortMode] = useState(false);
  const [orderDraft, setOrderDraft] = useState([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const sortSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const fetchCollections = async () => {
    try {
      setLoading(true);
      const data = await loadShopCollections(shopId);
      data.sort(compareCollections);
      setCollections(data);
    } catch (err) {
      console.error('Error fetching collections:', err);
      setError('Kunde inte ladda samlingar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCollections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const handleDelete = async (id) => {
    if (!id) return;
    if (!window.confirm('Är du säker på att du vill ta bort denna samling? Åtgärden kan inte ångras.')) return;
    try {
      await deleteShopCollection(id);
      setCollections((prev) => prev.filter((c) => c.id !== id));
      toast.success('Samlingen har tagits bort');
    } catch (err) {
      console.error('Error deleting collection:', err);
      toast.error('Kunde inte ta bort samlingen: ' + (err.message || 'Okänt fel'));
    }
  };

  // Star toggle: optimistic flip, revert on write failure.
  const toggleFeatured = async (c) => {
    const next = !isCollectionFeatured(c);
    setCollections((prev) => prev.map((x) => (x.id === c.id ? { ...x, featured: next } : x)));
    try {
      await setCollectionFeatured(c.id, next);
    } catch (err) {
      console.error('Error toggling featured:', err);
      setCollections((prev) => prev.map((x) => (x.id === c.id ? { ...x, featured: c.featured } : x)));
      toast.error('Kunde inte uppdatera Utvald');
    }
  };

  const enterSortMode = () => {
    setOrderDraft([...collections].sort(compareCollections));
    setSortMode(true);
  };

  const onSortDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setOrderDraft((prev) => {
      const from = prev.findIndex((c) => c.id === active.id);
      const to = prev.findIndex((c) => c.id === over.id);
      if (from < 0 || to < 0) return prev;
      return arrayMove(prev, from, to);
    });
  };

  const saveOrder = async () => {
    try {
      setSavingOrder(true);
      await saveCollectionOrder(orderDraft);
      const orderIdx = new Map(orderDraft.map((c, i) => [c.id, i]));
      setCollections((prev) =>
        prev.map((c) => (orderIdx.has(c.id) ? { ...c, sortOrder: orderIdx.get(c.id) } : c)).sort(compareCollections)
      );
      setSortMode(false);
      toast.success('Ordningen sparad');
    } catch (err) {
      console.error('Error saving collection order:', err);
      toast.error('Kunde inte spara ordningen: ' + (err.message || 'Okänt fel'));
    } finally {
      setSavingOrder(false);
    }
  };

  if (!isAdmin) {
    return (
      <AppLayout>
        <Page title="Samlingar">
          <p className="text-[13px] text-admin-text">Du har inte behörighet att komma åt denna sida.</p>
          <Link to="/" className="text-[13px] text-admin-text underline">Tillbaka till Dashboard</Link>
        </Page>
      </AppLayout>
    );
  }

  const memberCount = (c) => {
    if (c.type === 'smart') return c.rule?.tag ? `#${c.rule.tag}` : '—';
    if (Number.isFinite(c.productCount)) return c.productCount;
    return Array.isArray(c.productIds) ? c.productIds.length : 0;
  };

  const columns = [
    {
      key: 'collection',
      header: 'Samling',
      render: (c) => (
        <div className="flex items-center gap-3">
          {c.imageUrl ? (
            <img src={c.imageUrl} alt="" className="h-9 w-9 shrink-0 rounded-[6px] border border-admin-border object-cover" />
          ) : (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[6px] border border-admin-border bg-admin-surface-2 text-[10px] text-admin-text-faint">—</div>
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium text-admin-text group-hover:underline">{c.title || 'Namnlös'}</span>
            <span className="block truncate text-[12px] text-admin-text-faint">/{c.handle}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'featured',
      header: 'Utvald',
      align: 'center',
      className: 'w-16',
      render: (c) => {
        const on = isCollectionFeatured(c);
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFeatured(c); }}
            title={on ? 'Ta bort från Populära samlingar på startsidan' : 'Visa i Populära samlingar på startsidan'}
            aria-label={on ? 'Ta bort från Populära samlingar' : 'Visa i Populära samlingar'}
            aria-pressed={on}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] hover:bg-admin-surface-2"
          >
            {on ? <StarSolidIcon className="h-5 w-5 text-amber-400" /> : <StarIcon className="h-5 w-5 text-admin-text-faint" />}
          </button>
        );
      },
    },
    {
      key: 'type',
      header: 'Typ',
      render: (c) => <span className="text-admin-text-muted">{c.type === 'smart' ? 'Smart' : 'Manuell'}</span>,
    },
    {
      key: 'members',
      header: 'Produkter',
      align: 'right',
      render: (c) => <span className="tabular-nums text-admin-text-muted">{memberCount(c)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (c.published ? <StatusPill tone="success">Publicerad</StatusPill> : <StatusPill tone="neutral">Utkast</StatusPill>),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-12',
      render: (c) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }}
          title="Ta bort samling"
          aria-label="Ta bort samling"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      ),
    },
  ];

  if (sortMode) {
    return (
      <AppLayout>
        <Page
          title="Ändra ordning"
          actions={
            <>
              <Button variant="secondary" onClick={() => setSortMode(false)} disabled={savingOrder}>Avbryt</Button>
              <Button variant="primary" onClick={saveOrder} disabled={savingOrder}>{savingOrder ? 'Sparar…' : 'Spara ordning'}</Button>
            </>
          }
        >
          <p className="mb-3 text-[13px] text-admin-text-muted">
            Dra samlingarna i den ordning de ska visas — i menyn och i "Populära samlingar" på startsidan.
          </p>
          <div className="overflow-hidden rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface">
            {orderDraft.length === 0 ? (
              <p className="px-3 py-10 text-center text-[13px] text-admin-text-muted">Inga samlingar att sortera.</p>
            ) : (
              <DndContext sensors={sortSensors} collisionDetection={closestCenter} onDragEnd={onSortDragEnd}>
                <SortableContext items={orderDraft.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                  {orderDraft.map((c, i) => (
                    <SortableCollectionRow key={c.id} item={c} position={i + 1} />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>
        </Page>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Page
        title="Samlingar"
        actions={
          <>
            <Button variant="secondary" onClick={enterSortMode} disabled={loading || collections.length < 2}>Ändra ordning</Button>
            <Button variant="primary" onClick={() => navigate('/admin/collections/new')}>Lägg till samling</Button>
          </>
        }
      >
        {error && (
          <div className="mb-3 rounded-[var(--radius-admin)] border border-admin-critical-dot/30 bg-admin-critical-bg px-4 py-3 text-[13px] text-admin-critical-text">
            {error}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={collections}
          rowKey={(c) => c.id}
          loading={loading}
          onRowClick={(c) => navigate(`/admin/collections/${c.id}`)}
          empty="Inga samlingar ännu. Skapa din första för att gruppera produkter (t.ex. per artist)."
        />
      </Page>
    </AppLayout>
  );
};

export default AdminCollections;
