// WagonManifest.js — Print on Demand (POD) wagon manifest.
//
// POD is ONE add-on among many — the platform is NOT POD-exclusive. A shop owner
// who enables it can upload print artwork ("original"), validate it against print
// specs, map artwork → product SKU, and the print shop downloads print-ready files
// + production metadata per order. The SELLER uploads their own artwork (no design
// editor, no customer-facing upload). See docs/POD_ADDON_PLAN.md.
//
// Connection to the add-on system:
//   • `enabled: true` is REQUIRED — WagonRegistry.registerWagon only mounts a
//     wagon (routes + menu) when enabled === true. (writers-wagon is enabled:false
//     and never mounts; POD must be true.)
//   • Per-shop entitlement is a SEPARATE layer: shops/{id}.features.pod (toggled in
//     the platform /addons console). The route + menu item appear only when BOTH
//     manifest.enabled AND features.pod (explicit OPT-IN since the 2026-08-18 D3 flip) are true — App.jsx wraps the
//     wagon route in <AddonGate feature="pod"> and AppLayout filters the menu item
//     by the same key (config/addons.js WAGON_FEATURE_KEY['pod-wagon'] === 'pod').
//
// LEGAL FIREWALL: from the Design Studio (slice 4) POD DOES create products — the
// shop owner's own artwork on garment templates — but it must NEVER set
// product.isPersonalized true. That flag removes the 14-day right of withdrawal and
// is reserved for customer-supplied input; it is derived at ORDER creation by the
// buyer flow, never by product authoring. So studio-created products always ship
// isPersonalized:false, and POD still never touches cart/checkout. The invariant is
// structural: the publish path hard-codes isPersonalized:false.

export const PodWagonManifest = {
  id: 'pod-wagon',
  name: 'Print on Demand',
  version: '1.0.0',
  type: 'fulfillment',
  enabled: true, // REQUIRED true to mount (see note above). Per-shop gate is features.pod.

  author: 'Meteor PR',
  license: 'proprietary',
  tags: ['pod', 'print-on-demand', 'fulfillment', 'artwork'],

  // Admin menu entry. NOTE: AppLayout renders a shared SparklesIcon for all wagon
  // menu items — the `icon` string here is documentation only, not used for render.
  adminMenu: {
    title: 'Print on demand',
    icon: 'PhotoIcon',
    path: '/admin/pod',
    order: 80,
    description: 'Tryckoriginal, validering och produktionsfiler',
    component: 'AdminComponent',
  },

  routes: [
    {
      path: '/admin/pod',
      component: 'AdminComponent',
      private: true,
      adminOnly: true,
      title: 'Print on demand',
    },
  ],
};

export default PodWagonManifest;
