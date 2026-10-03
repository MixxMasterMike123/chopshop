// src/wagons/WagonRegistry.js for the admin build (alias list,
// vite.admin.config.js). No wagon is discovered in this build (D2: the
// dining, ambassador, campaign and writers wagons are deleted; the registry
// read Firestore). The one add-on that stays, POD, is a STATIC entry: the
// same menu item its manifest declares, which AppLayout shows only when the
// shop's `features.pod` is on (config/addons.js WAGON_FEATURE_KEY), and a
// static route in AdminApp.jsx behind AddonGate.

import { PodWagonManifest } from '../../wagons/pod-wagon/WagonManifest.js';

const STATIC_MENU = Object.freeze([
  Object.freeze({ ...PodWagonManifest.adminMenu, wagonId: PodWagonManifest.id }),
]);

const wagonRegistry = {
  async ensureWagonsDiscovered() {},
  getAdminMenuItemsSync() {
    return STATIC_MENU.map((item) => ({ ...item }));
  },
  async getAdminMenuItems() {
    return this.getAdminMenuItemsSync();
  },
  getUserMenuItemsSync() {
    return [];
  },
};

export default wagonRegistry;
