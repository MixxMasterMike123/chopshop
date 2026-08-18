// AdminProducts — the product LIST for a shop. The create/edit form lives in
// components/admin/ProductForm.jsx (extracted 2026-06-15: de-B2B, single tab, no
// translations, single price). This page owns: load (shop-scoped), the list
// table, open/edit/delete, the featured star (frontpage "Utvalt"), the
// storefront drag-sort mode (persists per-product sortOrder), and group-name
// collection for the form's autocomplete.
import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs, doc, deleteDoc, updateDoc, writeBatch, serverTimestamp, query, where } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { useAuth } from '../../contexts/AuthContext';
import { useShopId } from '../../contexts/ShopContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import toast from 'react-hot-toast';
import ProductMenu from '../../components/ProductMenu';
import AppLayout from '../../components/layout/AppLayout';
import ProductForm from '../../components/admin/ProductForm';
import { Page, DataTable, StatusPill, Button } from '../../components/admin/ui';
import { TrashIcon, StarIcon, CubeIcon, PaintBrushIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isProductFeatured, sortProductsForDisplay } from '../../utils/productSorting';

// Read a product name that may be a legacy per-locale object or a plain string.
const productName = (name) => {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') {
    return name['sv-SE'] || Object.values(name).find((v) => typeof v === 'string') || '';
  }
  return '';
};

// One draggable row in sort mode. Drag listeners sit ONLY on the grip (same
// idiom as the variants rail in ProductForm) so text selection etc. stays sane.
const SortableProductRow = ({ product, position }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: product.id });
  const img = product.imageUrl || product.b2cImageUrl;
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
      {img ? (
        <img src={img} alt="" className="h-9 w-9 shrink-0 rounded-[6px] border border-admin-border object-cover" />
      ) : (
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[6px] border border-admin-border bg-admin-surface-2 text-[10px] text-admin-text-faint">
          —
        </div>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-admin-text">
          {productName(product.name) || 'Namnlös'}
        </span>
        {product.sku && <span className="block truncate text-[12px] text-admin-text-faint">{product.sku}</span>}
      </span>
      <span className="hidden truncate text-[12px] text-admin-text-muted sm:block sm:max-w-[10rem]">
        {product.category || product.group || ''}
      </span>
      {isProductFeatured(product) && (
        <span title="Utvald på startsidan" className="shrink-0">
          <StarSolidIcon className="h-4 w-4 text-amber-400" />
        </span>
      )}
      {!product.isActive && <StatusPill tone="neutral">Utkast</StatusPill>}
    </div>
  );
};

const AdminProducts = () => {
  const { isAdmin } = useAuth();
  const shopId = useShopId();
  const navigate = useNavigate();
  const { isEnabled } = useShopFeatures();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [availableCategories, setAvailableCategories] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);

  // Form state: null = list view; { choosing: true } = "what kind of product?"
  // chooser (POD shops only); { product: null } = create plain product;
  // { product } = edit an existing product.
  const [editing, setEditing] = useState(null);

  // List filter (ProductMenu).
  const [filteredProduct, setFilteredProduct] = useState(null);

  // Sort mode: drag products into the storefront display order. orderDraft is
  // the working copy; nothing is persisted until "Spara ordning".
  const [sortMode, setSortMode] = useState(false);
  const [orderDraft, setOrderDraft] = useState([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const sortSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const fetchProducts = async () => {
    try {
      setLoading(true);
      const snap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
      const data = [];
      const categories = new Set();
      const tags = new Set();
      snap.forEach((d) => {
        const p = { ...d.data(), id: d.id };
        data.push(p);
        // category (new) with fallback to the legacy `group` field.
        const cat = (p.category || p.group || '').trim();
        if (cat) categories.add(cat);
        if (Array.isArray(p.tags)) p.tags.forEach((t) => t && t.trim() && tags.add(t.trim()));
      });
      data.sort((a, b) => productName(a.name).localeCompare(productName(b.name)));
      setProducts(data);
      setAvailableCategories(Array.from(categories).sort());
      setAvailableTags(Array.from(tags).sort());
    } catch (err) {
      console.error('Error fetching products:', err);
      setError('Kunde inte ladda produkter');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const handleDeleteProduct = async (productId) => {
    if (!productId) {
      toast.error('Fel: Produkt-ID saknas.');
      return;
    }
    if (!window.confirm('Är du säker på att du vill ta bort denna produkt? Denna åtgärd kan inte ångras.')) return;
    try {
      setLoading(true);
      await deleteDoc(doc(db, 'products', productId));
      setProducts((prev) => prev.filter((p) => p.id !== productId));
      if (editing?.product?.id === productId) setEditing(null);
      toast.success('Produkten har tagits bort');
    } catch (err) {
      if (err.code === 'not-found') {
        setProducts((prev) => prev.filter((p) => p.id !== productId));
        if (editing?.product?.id === productId) setEditing(null);
        toast.success('Produkten har tagits bort');
      } else {
        console.error('Error deleting product:', err);
        toast.error('Kunde inte ta bort produkten: ' + (err.message || 'Okänt fel'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Star toggle: optimistic flip, revert on write failure. Writes the explicit
  // boolean (which supersedes the legacy `featured` tag — see isProductFeatured).
  const toggleFeatured = async (p) => {
    const next = !isProductFeatured(p);
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, featured: next } : x)));
    try {
      await updateDoc(doc(db, 'products', p.id), { featured: next, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Error toggling featured:', err);
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, featured: p.featured } : x)));
      toast.error('Kunde inte uppdatera Utvald');
    }
  };

  const enterSortMode = () => {
    // Start from the CURRENT storefront order so a drag session tweaks what
    // shoppers actually see, not the admin list's alphabetical order.
    setOrderDraft(sortProductsForDisplay(products, (p) => productName(p.name), 'sv'));
    setSortMode(true);
  };

  const onSortDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setOrderDraft((prev) => {
      const from = prev.findIndex((p) => p.id === active.id);
      const to = prev.findIndex((p) => p.id === over.id);
      if (from < 0 || to < 0) return prev;
      return arrayMove(prev, from, to);
    });
  };

  const saveOrder = async () => {
    try {
      setSavingOrder(true);
      // Positions are just the draft index. Batched writes, chunked well under
      // Firestore's 500-op batch limit.
      for (let i = 0; i < orderDraft.length; i += 400) {
        const batch = writeBatch(db);
        orderDraft.slice(i, i + 400).forEach((p, j) => {
          batch.update(doc(db, 'products', p.id), { sortOrder: i + j, updatedAt: serverTimestamp() });
        });
        await batch.commit();
      }
      const orderIdx = new Map(orderDraft.map((p, i) => [p.id, i]));
      setProducts((prev) => prev.map((p) => (orderIdx.has(p.id) ? { ...p, sortOrder: orderIdx.get(p.id) } : p)));
      setSortMode(false);
      toast.success('Ordningen sparad');
    } catch (err) {
      console.error('Error saving product order:', err);
      toast.error('Kunde inte spara ordningen: ' + (err.message || 'Okänt fel'));
    } finally {
      setSavingOrder(false);
    }
  };

  if (!isAdmin) {
    return (
      <AppLayout>
        <Page title="Produkter">
          <p className="text-[13px] text-admin-text">Du har inte behörighet att komma åt denna sida.</p>
          <Link to="/" className="text-[13px] text-admin-text underline">Tillbaka till Dashboard</Link>
        </Page>
      </AppLayout>
    );
  }

  const onSaved = async () => {
    await fetchProducts();
    setEditing(null);
  };

  const formatSek = (n) =>
    new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: 2 }).format(n || 0);

  const productPrice = (p) => p.b2cPrice || p.basePrice || 0;
  const productImg = (p) => p.imageUrl || p.b2cImageUrl;

  // Shopify Products IndexTable columns. NO inventory column — we don't track
  // stock (honesty rule: render only real data).
  const columns = [
    {
      key: 'product',
      header: 'Produkt',
      render: (p) => {
        const img = productImg(p);
        return (
          <div className="flex items-center gap-3">
            {img ? (
              <img src={img} alt="" className="h-9 w-9 shrink-0 rounded-[6px] border border-admin-border object-cover" />
            ) : (
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[6px] border border-admin-border bg-admin-surface-2 text-[10px] text-admin-text-faint">
                —
              </div>
            )}
            <span className="min-w-0">
              <span className="block truncate font-medium text-admin-text group-hover:underline">
                {productName(p.name) || 'Namnlös'}
              </span>
              {p.sku && <span className="block truncate text-[12px] text-admin-text-faint">{p.sku}</span>}
            </span>
          </div>
        );
      },
    },
    {
      // WooCommerce/BigCommerce-style featured star: click = show/hide the
      // product in the storefront's "Utvalt" frontpage section.
      key: 'featured',
      header: 'Utvald',
      align: 'center',
      className: 'w-16',
      render: (p) => {
        const on = isProductFeatured(p);
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleFeatured(p);
            }}
            title={on ? 'Ta bort från Utvalt på startsidan' : 'Visa i Utvalt på startsidan'}
            aria-label={on ? 'Ta bort från Utvalt på startsidan' : 'Visa i Utvalt på startsidan'}
            aria-pressed={on}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] hover:bg-admin-surface-2"
          >
            {on ? (
              <StarSolidIcon className="h-5 w-5 text-amber-400" />
            ) : (
              <StarIcon className="h-5 w-5 text-admin-text-faint" />
            )}
          </button>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) =>
        p.isActive ? (
          <StatusPill tone="success">Aktiv</StatusPill>
        ) : (
          <StatusPill tone="neutral">Utkast</StatusPill>
        ),
    },
    {
      key: 'category',
      header: 'Kategori',
      render: (p) => <span className="text-admin-text-muted">{p.category || p.group || '—'}</span>,
    },
    {
      key: 'variants',
      header: 'Varianter',
      align: 'right',
      render: (p) => (
        <span className="tabular-nums text-admin-text-muted">
          {Array.isArray(p.variants) && p.variants.length > 0 ? p.variants.length : '—'}
        </span>
      ),
    },
    {
      key: 'price',
      header: 'Pris',
      align: 'right',
      render: (p) => <span className="font-medium tabular-nums text-admin-text">{formatSek(productPrice(p))}</span>,
    },
    {
      // Trailing delete action; stop row click so it doesn't open the editor.
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-12',
      render: (p) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleDeleteProduct(p.id);
          }}
          title="Ta bort produkt"
          aria-label="Ta bort produkt"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      ),
    },
  ];

  const rows = filteredProduct ? [filteredProduct] : products;

  // ── Chooser view: POD shops pick "Vanlig produkt" vs "POD-produkt" before
  // the create form opens. Same <Page> frame as the form so the transition
  // from list → chooser → form reads as one flow, not a detour. ──
  if (editing?.choosing) {
    return (
      <AppLayout>
        <Page title="Ny produkt" back={{ to: '/admin/products', label: 'Produkter' }}>
          <p className="mb-4 text-[13px] text-admin-text-muted">Vad vill du skapa?</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setEditing({ product: null })}
              className="rounded-admin border border-admin-border bg-admin-surface p-5 text-left hover:border-admin-text-faint hover:bg-admin-surface-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
            >
              <CubeIcon className="h-6 w-6 text-admin-text-muted" />
              <div className="mt-3 text-[14px] font-semibold text-admin-text">Vanlig produkt</div>
              <p className="mt-1 text-[12px] text-admin-text-muted">
                Lägg upp en produkt med bilder, pris och varianter.
              </p>
            </button>
            <button
              type="button"
              onClick={() => navigate('/admin/pod?tab=studio')}
              className="rounded-admin border border-admin-border bg-admin-surface p-5 text-left hover:border-admin-text-faint hover:bg-admin-surface-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
            >
              <PaintBrushIcon className="h-6 w-6 text-admin-text-muted" />
              <div className="mt-3 text-[14px] font-semibold text-admin-text">POD-produkt</div>
              <p className="mt-1 text-[12px] text-admin-text-muted">
                Designa tryck i studion — produkten skapas när du publicerar.
              </p>
            </button>
          </div>
        </Page>
      </AppLayout>
    );
  }

  // ── Form view: keep ProductForm host untouched (slice 1e redesigns it). ──
  if (editing) {
    return (
      <AppLayout>
        <Page title={editing.product ? 'Redigera produkt' : 'Ny produkt'} back={{ to: '/admin/products', label: 'Produkter' }}>
          <ProductForm
            product={editing.product}
            shopId={shopId}
            availableCategories={availableCategories}
            availableTags={availableTags}
            onSaved={onSaved}
            onCancel={() => setEditing(null)}
          />
        </Page>
      </AppLayout>
    );
  }

  // ── Sort mode: drag rows into the storefront display order. ──
  if (sortMode) {
    return (
      <AppLayout>
        <Page
          title="Ändra ordning"
          actions={
            <>
              <Button variant="secondary" onClick={() => setSortMode(false)} disabled={savingOrder}>
                Avbryt
              </Button>
              <Button variant="primary" onClick={saveOrder} disabled={savingOrder}>
                {savingOrder ? 'Sparar…' : 'Spara ordning'}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-[13px] text-admin-text-muted">
            Dra produkterna i den ordning de ska visas i butiken. Ordningen gäller startsidan,
            Utvalt-sektionen och kategorisidorna. Utkast har en plats i ordningen men visas inte
            förrän de aktiveras.
          </p>
          <div className="overflow-hidden rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface">
            {orderDraft.length === 0 ? (
              <p className="px-3 py-10 text-center text-[13px] text-admin-text-muted">Inga produkter att sortera.</p>
            ) : (
              <DndContext sensors={sortSensors} collisionDetection={closestCenter} onDragEnd={onSortDragEnd}>
                <SortableContext items={orderDraft.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                  {orderDraft.map((p, i) => (
                    <SortableProductRow key={p.id} product={p} position={i + 1} />
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
        title="Produkter"
        actions={
          <>
            <Button variant="secondary" onClick={enterSortMode} disabled={loading || products.length < 2}>
              Ändra ordning
            </Button>
            <Button
              variant="primary"
              onClick={() => (isEnabled('pod') ? setEditing({ choosing: true }) : setEditing({ product: null }))}
            >
              Lägg till produkt
            </Button>
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
          rows={rows}
          rowKey={(p) => p.id}
          loading={loading}
          onRowClick={(p) => setEditing({ product: { ...p, documentId: p.id } })}
          empty="Inga produkter hittades."
          toolbar={
            <div className="w-full sm:max-w-xs">
              <ProductMenu
                products={products}
                selectedProduct={filteredProduct}
                onProductSelect={(p) => setFilteredProduct(p)}
              />
            </div>
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminProducts;
