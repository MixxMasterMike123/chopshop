// The Cloudflare admin's entry (index.admin.html, vite.admin.config.js). ONE
// build, two trees (D102): an address under /platform mounts the platform
// console (PlatformApp, basename /platform), every other address the shop
// admin (AdminApp). Moving between the two is a full page load.

import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import AdminApp from './AdminApp.jsx';
import PlatformApp from './PlatformApp.jsx';

const path = window.location.pathname;
const isPlatformTree = path === '/platform' || path.startsWith('/platform/');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>{isPlatformTree ? <PlatformApp /> : <AdminApp />}</React.StrictMode>,
);
