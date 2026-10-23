// Affiliateportalen — Material (/affiliate/material; CP13 design §7.1b,
// §7.3): the shop's marketing materials, ONLY while the shop's
// `marketingMaterials` add-on is on. The portal's contract (GET
// /v1/affiliate/me, CP13_A1_REPORT.md §4.2) names no such switch and no
// route that lists the materials, so the address leads to the overview and
// the page is not linked (CP13_A3_REPORT.md, "contract gaps").

import React from 'react';
import { Navigate } from 'react-router-dom';

export default function AffiliateMaterial() {
  return <Navigate to="/" replace />;
}
