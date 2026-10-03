// src/contexts/SimpleAuthContext.jsx for the admin build (alias list,
// vite.admin.config.js). The Firebase provider is the storefront customers'
// Firebase Auth; the admin has no customer accounts. ForgotPasswordPage reads
// `resetPassword` from it: here that is the admin session's (Better Auth's
// reset request, src/api/admin/session.js). Everything else says nobody is
// signed in as a customer.

import { useAuth } from '../providers/Session.jsx';

const noCustomerAccounts = async () => {
  throw new Error('Kundkonton finns inte i admin.');
};

export function useSimpleAuth() {
  const auth = useAuth();
  return {
    currentUser: null,
    loading: false,
    error: null,
    login: noCustomerAccounts,
    register: noCustomerAccounts,
    logout: async () => {},
    resetPassword: auth.resetPassword,
    updateB2CCustomerEmailStatus: async () => {},
  };
}

export function SimpleAuthContextProvider({ children }) {
  return children;
}
