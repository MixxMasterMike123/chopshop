// The affiliate portal's shared state (CP13): the shell (AffiliateApp.jsx)
// provides it, the pages read it. `affiliate` is the server's PortalMe for
// the shop in use; `setAffiliate` takes a fresh one (the profile's and the
// terms' answers), `reload()` asks for it again.

import { createContext, useContext } from 'react';

export const PortalContext = createContext({
  affiliate: null,
  shopId: null,
  shopName: null,
  reload: async () => null,
  setAffiliate: () => {},
});

export function usePortal() {
  return useContext(PortalContext);
}
