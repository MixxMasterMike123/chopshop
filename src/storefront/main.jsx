// The Cloudflare storefront's entry (index.storefront.html,
// vite.storefront.config.js). The admin, platform and print surfaces keep
// src/main.jsx and the Firebase build until CP5.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import '../index.css';
import StorefrontApp from './StorefrontApp.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HelmetProvider>
      <StorefrontApp />
    </HelmetProvider>
  </React.StrictMode>,
);
