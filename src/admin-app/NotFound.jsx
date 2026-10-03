// An address the admin does not hold (a page that left the build, gap analysis
// §1b, or a mistyped one): as the Firebase admin did (App.jsx catch-all), back
// to the root, which sends a signed-out user to /login and anyone else to the
// dashboard. No page of its own: there is no baseline to match.

import React from 'react';
import { Navigate } from 'react-router-dom';

export default function NotFound() {
  return <Navigate to="/" replace />;
}
