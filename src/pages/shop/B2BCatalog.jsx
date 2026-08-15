// B2BCatalog — the wholesale catalog + order form for an active B2B customer.
// Lists the CURRENT shop's products (where shopId == current) that are active and
// B2B-available (availability.b2b !== false), showing the wholesale price
// (b2bPrice, ex moms) — NOT the consumer price. The customer sets quantities and
// places a Faktura order via the createB2BOrder callable (totals are recomputed
// server-side from b2bPrice — the client total below is only a preview).
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../../firebase/config';
import { useShopId } from '../../contexts/ShopContext';
import { useB2BCustomer } from '../../contexts/B2BCustomerContext';
import { useTranslation } from '../../contexts/TranslationContext';
import toast from 'react-hot-toast';

const productName = (n) => {
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object') return n['sv-SE'] || Object.values(n).find((v) => typeof v === 'string') || '';
  return '';
};
const sek = (n) =>
  new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: 2 }).format(n || 0);
const VAT_RATE = 0.25; // preview only — the server recomputes authoritatively

export default function B2BCatalog() {
  const shopId = useShopId();
  const navigate = useNavigate();
  const { profile } = useB2BCustomer();
  const { t } = useTranslation();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [qty, setQty] = useState({}); // productId -> quantity
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // INTENTIONALLY the raw collection: b2bPrice is excluded from the
        // public productsPublic projection. Since the P1-11 rules tightening,
        // raw products are admin-read-only, so this retired add-on's catalog
        // only loads for shop admins — a rebuild needs a server-side
        // projection/callable for B2B customers.
        const snap = await getDocs(query(collection(db, 'products'), where('shopId', '==', shopId)));
        const list = [];
        snap.forEach((d) => {
          const p = { id: d.id, ...d.data() };
          if (p.isActive !== false && p.availability?.b2b !== false) list.push(p);
        });
        list.sort((a, b) => productName(a.name).localeCompare(productName(b.name)));
        if (!cancelled) setProducts(list);
      } catch (err) {
        console.warn('B2BCatalog: load failed:', err?.message);
        if (!cancelled) setProducts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  const setQuantity = (id, val) => {
    const n = Math.max(0, Math.floor(Number(val) || 0));
    setQty((q) => ({ ...q, [id]: n }));
  };

  // Order lines = products with qty > 0 AND a usable wholesale price.
  const lines = useMemo(
    () =>
      products
        .filter((p) => (qty[p.id] || 0) > 0 && typeof p.b2bPrice === 'number' && p.b2bPrice > 0)
        .map((p) => ({ product: p, quantity: qty[p.id], lineTotal: p.b2bPrice * qty[p.id] })),
    [products, qty]
  );
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const vat = subtotal * VAT_RATE;
  const total = subtotal + vat;

  const placeOrder = async () => {
    if (!profile?.id || lines.length === 0) return;
    setPlacing(true);
    try {
      const fn = httpsCallable(getFunctions(), 'createB2BOrder');
      const res = await fn({
        b2bCustomerId: profile.id,
        items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      });
      toast.success(t('b2b_order_placed', `Order skickad: ${res.data?.orderNumber || ''}`));
      setQty({});
      navigate(`/${shopId}/b2b/orders`);
    } catch (err) {
      console.error('createB2BOrder failed:', err);
      toast.error(err?.message || t('b2b_order_failed', 'Kunde inte skicka order'));
    } finally {
      setPlacing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">{t('b2b_nav_catalog', 'Grossistkatalog')}</h1>
      <p className="mt-2 text-sm text-gray-600">
        {t('b2b_catalog_intro', 'Alla priser är grossistpriser, exklusive moms. Ange antal och skicka din order.')}
      </p>

      {products.length === 0 ? (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          {t('b2b_catalog_empty', 'Inga produkter är tillgängliga för grossist just nu.')}
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Product list (2 cols) */}
          <div className="lg:col-span-2 space-y-2">
            {products.map((p) => {
              const img = p.imageUrl || p.b2cImageUrl;
              const hasWholesale = typeof p.b2bPrice === 'number' && p.b2bPrice > 0;
              return (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3">
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded bg-gray-50">
                    {img ? (
                      <img src={img} alt={productName(p.name)} className="h-full w-full object-cover" loading="lazy" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-gray-900">{productName(p.name) || t('b2b_catalog_unnamed', 'Namnlös')}</div>
                    <div className="text-xs text-gray-500">
                      {hasWholesale ? `${sek(p.b2bPrice)} ${t('b2b_catalog_ex_vat', 'exkl. moms')}` : t('b2b_catalog_no_price', 'Pris på förfrågan')}
                      {p.sku ? ` · ${p.sku}` : ''}
                    </div>
                  </div>
                  {hasWholesale && (
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={qty[p.id] || ''}
                      onChange={(e) => setQuantity(p.id, e.target.value)}
                      placeholder="0"
                      aria-label={t('b2b_catalog_qty', 'Antal')}
                      className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-right text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Order summary (1 col, sticky) */}
          <div className="lg:col-span-1">
            <div className="sticky top-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-gray-900">{t('b2b_order_summary', 'Ordersammanfattning')}</h2>
              {lines.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500">{t('b2b_order_empty', 'Ange antal för att börja.')}</p>
              ) : (
                <>
                  <ul className="mt-3 space-y-1 text-sm">
                    {lines.map((l) => (
                      <li key={l.product.id} className="flex justify-between gap-2">
                        <span className="truncate text-gray-600">{l.quantity} × {productName(l.product.name)}</span>
                        <span className="tabular-nums text-gray-900">{sek(l.lineTotal)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-sm">
                    <div className="flex justify-between text-gray-600"><span>{t('b2b_order_subtotal', 'Delsumma (ex moms)')}</span><span className="tabular-nums">{sek(subtotal)}</span></div>
                    <div className="flex justify-between text-gray-600"><span>{t('b2b_order_vat', 'Moms 25%')}</span><span className="tabular-nums">{sek(vat)}</span></div>
                    <div className="flex justify-between font-semibold text-gray-900"><span>{t('b2b_order_total', 'Totalt')}</span><span className="tabular-nums">{sek(total)}</span></div>
                  </div>
                  <p className="mt-2 text-[11px] text-gray-400">{t('b2b_order_invoice_note', 'Betalning sker mot faktura. Frakt tillkommer separat.')}</p>
                </>
              )}
              <button
                type="button"
                onClick={placeOrder}
                disabled={placing || lines.length === 0}
                className="mt-4 w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {placing ? t('b2b_order_placing', 'Skickar...') : t('b2b_order_submit', 'Skicka order (faktura)')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
