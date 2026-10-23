// Affiliateportalen — Beställningar (/affiliate/orders; CP13 design §7.3):
// the orders attributed to the affiliate in this shop, paged (GET
// /v1/affiliate/orders). Order number, date, the base (ex VAT and shipping),
// the commission and its state; never a buyer field (the server's
// projection carries none).

import React, { useCallback, useEffect, useState } from 'react';
import { Button, CardSection, Page } from '../../../components/admin/ui';
import { listPortalOrders } from '../../../api/affiliate-portal.js';
import { OrderRows } from './Overview.jsx';

const PAGE_SIZE = 50;

export default function AffiliateOrders() {
  const [orders, setOrders] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async (after) => {
    setError(false);
    try {
      const { orders: list, nextCursor } = await listPortalOrders({ cursor: after ?? undefined, limit: PAGE_SIZE });
      setOrders((prev) => (after ? [...(prev ?? []), ...list] : list));
      setCursor(nextCursor);
    } catch (err) {
      if (err?.code !== 'unauthenticated') setError(true);
      setOrders((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  const more = async () => {
    setLoadingMore(true);
    await load(cursor);
    setLoadingMore(false);
  };

  return (
    <Page
      title="Beställningar"
      subtitle="Köp via din kod eller länk. Provisionen räknas på varuvärdet efter rabatt, exklusive moms och frakt."
    >
      <CardSection bodyClassName="p-0">
        {error && <p className="px-4 pt-4 text-admin-critical-text">Beställningarna kunde inte hämtas. Ladda om sidan.</p>}
        <OrderRows orders={orders} empty="Inga beställningar via din kod eller länk ännu." />
        {cursor && (
          <div className="border-t border-admin-border px-4 py-3 text-center">
            <Button onClick={more} disabled={loadingMore}>
              {loadingMore ? 'Hämtar…' : 'Visa fler'}
            </Button>
          </div>
        )}
      </CardSection>
      <p className="mt-3 text-[12px] text-admin-text-muted">
        Under ångerfrist: provisionen kan betalas ut 14 dagar efter köpet. Återförd: ordern har återbetalats eller bestridits.
      </p>
    </Page>
  );
}
