// The Cloudflare admin's entry (index.admin.html, vite.admin.config.js). ONE
// build, three trees (D102; CP13): an address under /platform mounts the
// platform console (PlatformApp, basename /platform), an address under
// /affiliate the affiliate portal (AffiliateApp, basename /affiliate, design
// §7.3), every other address the shop admin (AdminApp). Moving between the
// trees is a full page load.

import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import AdminApp from './AdminApp.jsx';
import AffiliateApp from './AffiliateApp.jsx';
import PlatformApp from './PlatformApp.jsx';

const path = window.location.pathname;
const under = (prefix) => path === prefix || path.startsWith(`${prefix}/`);
const Tree = under('/platform') ? PlatformApp : under('/affiliate') ? AffiliateApp : AdminApp;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Tree />
  </React.StrictMode>,
);
