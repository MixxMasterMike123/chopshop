// platformReportsHarness.jsx — DEV-ONLY harness for eyeballing Plattform →
// Anmälningar (ReportsView: the reports table + the Granskning queue) inside the
// real PlatformLayout, WITHOUT Firestore/auth. Open
// /platform-reports-harness.html (vite dev server); ?tab=review opens the
// Granskning tab.
//
// Fixtures cover every state the page renders: a new report (auto-expanded),
// one being reviewed, an unmatched one (manual product-ID field), a taken-down
// and a rejected one; in the queue a flagged, a hard-blocked (inactive) and a
// new-shop review product. Actions are stubbed with a toast + local state.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import '../index.css';
import PlatformLayout from '../components/platform/PlatformLayout';
import { ReportsView } from '../pages/platform/PlatformReports';

const ago = (h) => new Date(Date.now() - h * 3600 * 1000);
const IMG = '/images/Fil-000-222.jpg';

const REPORTS = [
  {
    id: 'rep_7Hq2kLmN01', status: 'new', createdAt: ago(2), shopId: 'melodie-mc',
    productId: 'p_kent', productName: 'Kent – Tour 2026 tee', productUrl: 'https://shop-meteorpr.web.app/melodie-mc/product/kent-tour-2026-tee_KENT-TOUR',
    product: { shopId: 'melodie-mc', sku: 'KENT-TOUR', name: 'Kent – Tour 2026 tee' },
    reporterName: 'Anna Lind', reporterOrg: 'Sony Music Sverige', reporterEmail: 'legal@example.se',
    rightType: 'trademark', attestation: true,
    description: 'Produkten använder bandnamnet Kent och bandets logotyp från turnén 2026. Säljaren har ingen licens från oss. Registrerat varumärke: EUTM 012345678.',
  },
  {
    id: 'rep_9PzX4aQw22', status: 'reviewing', createdAt: ago(20), shopId: 'ninetone',
    productId: 'p_star', productName: 'Galaxy hoodie', productUrl: '',
    product: { shopId: 'ninetone', sku: 'GALAXY-H', name: 'Galaxy hoodie' },
    reporterName: 'Jonas Berg', reporterOrg: '', reporterEmail: 'jonas@example.com',
    rightType: 'copyright', attestation: true,
    description: 'Illustrationen på ryggen är min, publicerad på min Instagram 2024. Den är kopierad rakt av.',
  },
  {
    id: 'rep_3VbN8uRt45', status: 'new', createdAt: ago(30), shopId: 'sillmans',
    productId: null, productName: null, productUrl: 'den blå tröjan med fotbollslogga',
    reporterName: 'Klubbens kansli', reporterOrg: 'IFK Exempel', reporterEmail: 'kansli@example.org',
    rightType: 'trademark', attestation: true,
    description: 'Klubbmärket används utan tillstånd på en blå tröja i butiken.',
  },
  {
    id: 'rep_1CxZ6yUi67', status: 'taken_down', createdAt: ago(72), handledAt: ago(60), shopId: 'melodie-mc',
    productId: 'p_nike', productName: 'Swoosh tee', productUrl: 'javascript:alert(1)', note: 'Uppenbar kopia av logotypen.',
    product: { shopId: 'melodie-mc', sku: 'SWOOSH', name: 'Swoosh tee' },
    reporterName: 'Brand Protection', reporterOrg: 'Nike Inc.', reporterEmail: 'bp@example.com',
    rightType: 'trademark', attestation: true, description: 'Använder vår registrerade logotyp.',
  },
  {
    id: 'rep_5MnB2vCx89', status: 'rejected', createdAt: ago(200), handledAt: ago(190), shopId: 'ninetone',
    productId: 'p_fish', productName: 'Gädda-tee', productUrl: '', note: 'Egen illustration, säljaren visade original.',
    product: { shopId: 'ninetone', sku: 'GADDA', name: 'Gädda-tee' },
    reporterName: 'Per Ek', reporterOrg: '', reporterEmail: 'per@example.com',
    rightType: 'other', attestation: true, description: 'Liknar min design väldigt mycket, tycker jag.',
  },
];

const QUEUE = [
  {
    id: 'q_kent', shopId: 'melodie-mc', sku: 'KENT-TOUR', name: 'Kent – Tour 2026 tee', isActive: true,
    b2cImageUrl: IMG, screening: { status: 'flagged', hits: ['kent', '™'], at: ago(1) },
  },
  {
    id: 'q_nike', shopId: 'ninetone', sku: 'JUST-DO', name: 'Just do it hoodie', isActive: false,
    b2cImageUrl: '', screening: { status: 'blocked', hits: ['nike'], at: ago(3) },
  },
  {
    id: 'q_renamed', shopId: 'sillmans', sku: 'TOUR-TEE', name: 'Tour tee (fd. Metallica)', isActive: true,
    b2cImageUrl: IMG, screening: { status: 'flagged', hits: [], earlierHits: ['metallica'], at: ago(5) },
  },
  {
    id: 'q_new', shopId: 'nyabutiken', sku: 'FISK-1', name: 'Fiskmotiv tee', isActive: true,
    b2cImageUrl: IMG, screening: { status: 'review', hits: [], at: ago(8) },
  },
];

const SHOP_NAMES = { 'melodie-mc': 'Melodie MC', ninetone: 'Ninetone', sillmans: 'Sillmans', nyabutiken: 'Nya butiken' };

const Harness = () => {
  const params = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState(params.get('tab') === 'review' ? 'review' : 'reports');
  const [reports, setReports] = useState(params.get('empty') ? [] : REPORTS);
  const [queue, setQueue] = useState(params.get('empty') ? [] : QUEUE);
  const setStatus = (id, status, extra = {}) =>
    setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status, ...extra } : r)));

  return (
    <MemoryRouter initialEntries={['/reports']}>
      <Toaster position="top-right" />
      <PlatformLayout badgeCounts={{ reports: reports.filter((r) => r.status === 'new').length }}>
        <ReportsView
          tab={tab}
          onTab={setTab}
          loading={false}
          reports={reports}
          queue={queue}
          shopNames={SHOP_NAMES}
          busyId={null}
          onTakedown={(r, pid, note) => { console.log('takedown', r.id, pid, note); setStatus(r.id, 'taken_down', { note, handledAt: new Date() }); toast.success('Produkten är avpublicerad'); }}
          onReject={(r, note) => { setStatus(r.id, 'rejected', { note, handledAt: new Date() }); toast.success('Anmälan avvisad'); }}
          onMarkReviewing={(r) => { setStatus(r.id, 'reviewing'); toast.success('Markerad som granskas'); }}
          onClear={(p) => { setQueue((q) => q.filter((x) => x.id !== p.id)); toast.success('Godkänd'); }}
          onTakedownProduct={(p) => { setQueue((q) => q.filter((x) => x.id !== p.id)); toast.success('Produkten är avpublicerad'); }}
        />
      </PlatformLayout>
    </MemoryRouter>
  );
};

createRoot(document.getElementById('root')).render(<Harness />);
