// src/config/activeShop.js for the admin build (alias list,
// vite.admin.config.js). The Firebase build kept three shop ids (the admin's
// own, the deep link, the operator's last pick) and ShopContext ranked them.
// Here there is ONE: the shop chosen in this tab (activeShopStore.js), which
// the ActiveShop provider honours only when `/v1/me` says the user may use it.
// The picker (setLastPickedShopId) and the deep-link intake
// (setDeepLinkShopId) keep calling what they call; both choose the shop.

import {
  getChosenShopId,
  setChosenShopId,
  subscribeChosenShopId,
} from '../providers/activeShopStore.js';

export const getActiveShopId = getChosenShopId;
export const setActiveShopId = setChosenShopId;
export const subscribeActiveShopId = subscribeChosenShopId;

export const getDeepLinkShopId = getChosenShopId;
export const setDeepLinkShopId = setChosenShopId;
export const subscribeDeepLinkShopId = subscribeChosenShopId;

export const getLastPickedShopId = getChosenShopId;
export const setLastPickedShopId = setChosenShopId;
export const subscribeLastPickedShopId = subscribeChosenShopId;
