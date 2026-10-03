// The admin build's replacement for src/contexts/AuthContext.jsx (alias list,
// vite.admin.config.js). `useAuth()` keeps the shape the pages read, fed by
// `GET /v1/me` instead of Firebase Auth and the users collection:
//
//   currentUser { uid, email, displayName }   userProfile = userData { role, … }
//   isAdmin  isPlatform  loading  error  isDemoMode (false)
//   login(email, password)   Better Auth sign-in, then /v1/me
//   logout()                 ends every open acting-as grant, then signs out
//   resetPassword(email)     asks for the reset mail
//   confirmPasswordReset(token, newPassword)   the new reset page (FA)
//   refresh()                re-reads /v1/me (after acting-as opens or closes)
//   me, accountType, memberships, actingAs    the raw answer, for the shells (FB)
//
// The functions of the Firebase context that have no route in this build
// (change e-mail or password, the old user editor) keep their names and
// reject with `not_available`; the CP5-FA report lists them.
//
// When the client finds the session gone (a 404 whose /v1/me re-read is a
// 401), the user is sent to /login, keeping where they were in the admin tree
// (LoginPage returns there); from the platform tree it is a full load of /login.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AdminApiError, notAvailable, onSessionLost } from '../../api/admin/client.js';
import {
  authStateFromMe,
  endActingAs,
  getMe,
  liveGrantsOf,
  membershipsOf,
  requestPasswordReset,
  resetPassword as submitPasswordReset,
  signIn,
  signOut,
} from '../../api/admin/session.js';
import { setChosenShopId } from './activeShopStore.js';

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

const unavailable = (what) => async () => {
  throw notAvailable(what);
};

// AuthContext.jsx members with no route in this build (CP5-FA report, list b).
const NOT_PORTED = Object.freeze({
  updateUserEmail: unavailable('Byta e-postadress'),
  updateUserPassword: unavailable('Byta lösenord här (använd "Glömt lösenord")'),
  updateUserProfile: unavailable('Ändra profilen'),
  updateAnyUserProfile: unavailable('Ändra en annan användares profil'),
  getAllUsers: unavailable('Användarlistan'),
  toggleUserActive: unavailable('Aktivera eller inaktivera en användare'),
  updateUserRole: unavailable('Ändra en användares roll'),
  updateUserMarginal: unavailable('Marginal per användare'),
  createUserProfile: unavailable('Skapa en användare'),
  sendCustomerWelcomeEmail: unavailable('Välkomstmejl med lösenord'),
  deleteCustomerAccount: unavailable('Radera ett konto'),
});

/** `tree`: 'admin' (the default) or 'platform' — where /login is reached from. */
export function AuthProvider({ children, tree = 'admin' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const next = await getMe();
    setMe(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((next) => {
        if (!cancelled) setMe(next);
      })
      .catch((err) => {
        // The API could not be asked: treated as signed out (the guards send
        // the user to /login), and said so.
        console.warn('Session: /v1/me failed:', err?.message);
        if (!cancelled) {
          setMe(null);
          setError(err?.message || 'network_error');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The session ran out under a page: back to /login.
  useEffect(
    () =>
      onSessionLost(() => {
        setMe(null);
        if (tree === 'platform') {
          window.location.assign('/login');
        } else if (location.pathname !== '/login') {
          navigate('/login', { replace: true, state: { from: location } });
        }
      }),
    [tree, navigate, location],
  );

  const login = useCallback(async (email, password) => {
    setError('');
    try {
      await signIn(email, password);
      const next = await getMe();
      if (!next) {
        // Signed in, but not an account the admin serves (or deactivated).
        await signOut().catch(() => {});
        throw new AdminApiError({ status: 401, code: 'unauthenticated', message: 'Kontot har inte åtkomst till admin.' });
      }
      setMe(next);
      return authStateFromMe(next).currentUser;
    } catch (err) {
      setError(err?.message || 'login_failed');
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    setError('');
    // An acting-as grant never outlives the operator's sign-in in this tab.
    for (const grant of liveGrantsOf(me)) {
      await endActingAs(grant.tenantId).catch((err) => console.warn('Acting-as: could not end:', err?.message));
    }
    try {
      await signOut();
    } finally {
      setChosenShopId(null);
      setMe(null);
    }
    return true;
  }, [me]);

  const resetPassword = useCallback(async (email) => {
    setError('');
    await requestPasswordReset(email);
    return true;
  }, []);

  const confirmPasswordReset = useCallback(async (token, newPassword) => {
    await submitPasswordReset(token, newPassword);
    return true;
  }, []);

  const value = useMemo(() => {
    const state = authStateFromMe(me);
    return {
      ...NOT_PORTED,
      currentUser: state.currentUser,
      userData: state.userProfile,
      userProfile: state.userProfile,
      isAdmin: state.isAdmin,
      isPlatform: state.isPlatform,
      loading,
      error,
      isDemoMode: false,
      login,
      logout,
      resetPassword,
      confirmPasswordReset,
      refresh,
      me,
      accountType: me?.accountType ?? null,
      memberships: membershipsOf(me),
      actingAs: liveGrantsOf(me),
    };
  }, [me, loading, error, login, logout, resetPassword, confirmPasswordReset, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const SessionProvider = AuthProvider;
