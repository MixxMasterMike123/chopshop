// The preview of an unpublished shop (D57): while this tab holds a preview
// grant for the shop on screen (src/api/client.js previewGrant), a small fixed
// banner says so, and the page asks not to be indexed. Mounted once, in the
// storefront's shell; it renders nothing otherwise. NORD tokens only.

import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { previewGrant } from '../api/client.js';

// The grant lives 30 minutes; the banner goes when it does.
const RECHECK_MS = 30 * 1000;

export default function PreviewBanner() {
  const { pathname } = useLocation();
  const [held, setHeld] = useState(() => previewGrant() !== null);

  useEffect(() => {
    setHeld(previewGrant() !== null);
    const timer = setInterval(() => setHeld(previewGrant() !== null), RECHECK_MS);
    return () => clearInterval(timer);
  }, [pathname]);

  if (!held) return null;
  return (
    <>
      <Helmet>
        <meta name="robots" content="noindex" />
      </Helmet>
      <div
        role="status"
        className="fixed inset-x-0 bottom-0 z-50 bg-ink text-surface font-body text-sm text-center px-4 py-2"
      >
        Förhandsvisning — butiken är inte publicerad
      </div>
    </>
  );
}
