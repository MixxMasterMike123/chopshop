// SimpleAuthContext for the Cloudflare storefront (alias list,
// vite.storefront.config.js). D81: the storefront has no customer accounts; a
// visitor buys as a guest. `useSimpleAuth()` keeps its shape and says that
// nobody is signed in, for good: the account functions refuse.
//
// Replaced because the Firebase provider is the Firebase Auth SDK.

import { createContext } from 'react';

const noAccounts = async () => {
  throw new Error('Kundkonton finns inte i den här butiken.');
};

const VALUE = Object.freeze({
  currentUser: null,
  loading: false,
  error: null,
  login: noAccounts,
  register: noAccounts,
  logout: async () => {},
  resetPassword: noAccounts,
  updateB2CCustomerEmailStatus: async () => {},
});

const SimpleAuthContext = createContext(VALUE);

export function useSimpleAuth() {
  return VALUE;
}

export function SimpleAuthContextProvider({ children }) {
  return children;
}

export default SimpleAuthContext;
