// The shop's not-found page: an address the grammar does not hold, an address
// of a page that left the build (D81: account, reviews, recovery, affiliate,
// B2B), or a shop the API does not know. The Firebase storefront sent such an
// address to the shop's home instead; there is no baseline page to match, so
// this one uses the NORD tokens only and waits for the design gate.

import React from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useStorefrontRoot } from './providers/ShopRoot.jsx';
import { useStorefront } from './providers/Storefront.jsx';

export default function NotFound() {
  const root = useStorefrontRoot();
  const { status } = useStorefront();
  const shopKnown = root !== null && status !== 'not_found' && status !== 'no_shop';

  return (
    <main className="min-h-screen bg-canvas text-ink font-body flex items-center justify-center px-4 py-16">
      <Helmet>
        <meta name="robots" content="noindex" />
      </Helmet>
      <div className="max-w-md text-center">
        <h1 className="font-display text-4xl font-bold tracking-tight">Sidan finns inte</h1>
        <p className="mt-3 text-ink-muted">Adressen leder inte till någon sida här.</p>
        {shopKnown && (
          <Link
            to={`${root}/`}
            className="inline-block mt-8 bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90"
          >
            Till butiken
          </Link>
        )}
      </div>
    </main>
  );
}
