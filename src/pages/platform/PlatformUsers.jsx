// PlatformUsers — operator console Settings → Användare. Lists platform
// super-admins + shop admins (reads users/ directly; firestore.rules lets a
// platform user read any user doc). Create a NEW super-admin and delete admins
// via the platform-only callables (createPlatformSuperAdmin / deletePlatformUser).
// Shop admins are still added per-shop on the Butiker page.
// The data lives in platformUsersData.js, which the admin build swaps for the
// API's (vite.admin.config.js).
import React, { useState, useEffect, useCallback } from 'react';
import {
  CAN_CREATE_PLATFORM_ADMIN,
  REMOVE_COPY,
  USER_LIFECYCLE,
  createSuperAdmin,
  inviteUser,
  loadUsers,
  reactivateUser,
  removeUser,
} from './platformUsersData';
import { useAuth } from '../../contexts/AuthContext';
import PlatformLayout from '../../components/platform/PlatformLayout';
import toast from 'react-hot-toast';
import {
  UsersIcon,
  UserPlusIcon,
  TrashIcon,
  ShieldCheckIcon,
  BuildingStorefrontIcon,
  ArrowPathIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline';

const PlatformUsers = () => {
  const { currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [workingId, setWorkingId] = useState(null); // reactivate / invite
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      setUsers(await loadUsers());
    } catch (e) {
      console.error('Error loading users:', e);
      setLoadError(true);
      toast.error('Kunde inte ladda användare');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (u) => {
    if (!window.confirm(REMOVE_COPY.confirm(u.email))) return;
    try {
      setDeletingId(u.uid);
      // null: the user is gone (the row goes); a row: the user is still listed, now inactive.
      const updated = await removeUser(u.uid);
      setUsers((prev) => (updated ? prev.map((x) => (x.uid === u.uid ? updated : x)) : prev.filter((x) => x.uid !== u.uid)));
      toast.success(REMOVE_COPY.done(u.email));
    } catch (e) {
      console.error('deletePlatformUser failed:', e);
      toast.error(e?.message || REMOVE_COPY.failed);
    } finally {
      setDeletingId(null);
    }
  };

  const handleReactivate = async (u) => {
    try {
      setWorkingId(u.uid);
      const updated = await reactivateUser(u.uid);
      setUsers((prev) => prev.map((x) => (x.uid === u.uid ? updated : x)));
      toast.success(`${u.email} återaktiverad`);
    } catch (e) {
      console.error('reactivateUser failed:', e);
      toast.error(e?.message || 'Kunde inte återaktivera användaren');
    } finally {
      setWorkingId(null);
    }
  };

  const handleInvite = async (u) => {
    try {
      setWorkingId(u.uid);
      await inviteUser(u.uid);
      toast.success(`Inbjudan skickad till ${u.email}`);
    } catch (e) {
      console.error('inviteUser failed:', e);
      toast.error(e?.message || 'Kunde inte skicka inbjudan');
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <PlatformLayout>
      <div className="px-6 py-8 md:px-10">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Användare</h1>
            <p className="text-gray-400 mt-1">Plattformsadministratörer och butiksadmins.</p>
          </div>
          {CAN_CREATE_PLATFORM_ADMIN && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              <UserPlusIcon className="h-4 w-4" />
              Ny plattformsadmin
            </button>
          )}
        </div>

        {loading ? (
          <div className="py-16 text-center text-gray-500">Laddar…</div>
        ) : loadError ? (
          <div className="py-16 text-center text-gray-400">
            <UsersIcon className="h-10 w-10 mx-auto mb-3 text-red-500/60" />
            <p>Kunde inte ladda användarna.</p>
            <button
              onClick={load}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-white/10"
            >
              Försök igen
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className="py-16 text-center text-gray-500">
            <UsersIcon className="h-10 w-10 mx-auto mb-3 text-gray-700" />
            Inga administratörer ännu.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900">
            <table className="min-w-full divide-y divide-white/10 text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">E-post</th>
                  <th className="px-4 py-3">Namn</th>
                  <th className="px-4 py-3">Roll</th>
                  <th className="px-4 py-3 text-right">Åtgärder</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {users.map((u, i) => {
                  const isSelf = u.uid === currentUser?.uid;
                  // Group divider: rows are sorted platform-first, so the first
                  // non-platform row starts the "shop admins" section. Makes the
                  // two kinds read as distinct groups, not one mixed roster.
                  const startsShopSection = !u.platform && (i === 0 || users[i - 1].platform);
                  return (
                    <React.Fragment key={u.uid}>
                    {startsShopSection && (
                      <tr className="bg-white/[0.02]">
                        <td colSpan={4} className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          Butiksadmins (hanteras i respektive butik)
                        </td>
                      </tr>
                    )}
                    <tr className="text-gray-200">
                      <td className="px-4 py-3">
                        {u.email}
                        {isSelf && <span className="ml-2 text-xs text-gray-500">(du)</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-400">{u.contactPerson || '–'}</td>
                      <td className="px-4 py-3">
                        {u.platform ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-300">
                            <ShieldCheckIcon className="h-3.5 w-3.5" />
                            Plattformsadmin
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300">
                            <BuildingStorefrontIcon className="h-3.5 w-3.5" />
                            Butiksadmin · {u.shopId || 'butik'}
                          </span>
                        )}
                        {USER_LIFECYCLE && u.suspended && (
                          <span className="ml-2 inline-flex items-center rounded-md bg-white/5 px-2 py-0.5 text-xs font-medium text-gray-400">
                            Inaktiv
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className={'flex justify-end' + (USER_LIFECYCLE ? ' gap-2' : '')}>
                          {USER_LIFECYCLE && !u.suspended && !u.hasPassword && (
                            <button
                              onClick={() => handleInvite(u)}
                              disabled={workingId === u.uid}
                              title="Skicka en inbjudan med länk för att välja lösenord"
                              className="inline-flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium bg-white/5 text-gray-300 hover:bg-white/10 disabled:opacity-50"
                            >
                              <EnvelopeIcon className="h-4 w-4" />
                              {workingId === u.uid ? 'Skickar…' : 'Skicka inbjudan'}
                            </button>
                          )}
                          {USER_LIFECYCLE && u.suspended ? (
                          <button
                            onClick={() => handleReactivate(u)}
                            disabled={workingId === u.uid}
                            title="Slå på kontot igen"
                            className="inline-flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium bg-white/5 text-gray-300 hover:bg-emerald-500/15 hover:text-emerald-300 disabled:opacity-50"
                          >
                            <ArrowPathIcon className="h-4 w-4" />
                            {workingId === u.uid ? 'Återaktiverar…' : 'Återaktivera'}
                          </button>
                          ) : (
                          <button
                            onClick={() => handleDelete(u)}
                            disabled={isSelf || deletingId === u.uid}
                            title={isSelf ? REMOVE_COPY.selfTitle : REMOVE_COPY.title}
                            className={
                              'inline-flex items-center gap-1 rounded-lg px-3 py-1 text-xs font-medium ' +
                              (isSelf
                                ? 'bg-white/5 text-gray-600 cursor-not-allowed'
                                : 'bg-white/5 text-gray-300 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50')
                            }
                          >
                            <TrashIcon className="h-4 w-4" />
                            {deletingId === u.uid ? REMOVE_COPY.busy : REMOVE_COPY.label}
                          </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {CAN_CREATE_PLATFORM_ADMIN && showCreate && (
        <CreateSuperAdminModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </PlatformLayout>
  );
};

// Inline (ponytail: no separate file for a one-off modal). Creates a platform
// super-admin via the callable, then refreshes the list.
const CreateSuperAdminModal = ({ onClose, onCreated }) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const trimmed = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      return setError('Ange en giltig e-postadress.');
    }
    setSaving(true);
    try {
      const data = await createSuperAdmin({ email: trimmed, name: name.trim() });
      if (data.emailSent) {
        toast.success(`Plattformsadmin skapad. Inloggningsuppgifter skickade till ${trimmed}.`);
      } else {
        toast(`Admin skapad men e-post misslyckades${data.emailError ? `: ${data.emailError}` : ''}. Skicka uppgifter manuellt.`, { icon: '⚠️' });
      }
      onCreated?.();
    } catch (err) {
      console.error('createPlatformSuperAdmin failed:', err);
      setError(err?.message || 'Kunde inte skapa användaren.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={saving ? undefined : onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-gray-900 border border-white/10 shadow-2xl text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-white/10 px-6 py-5">
          <div className="rounded-lg bg-indigo-500/15 p-2">
            <ShieldCheckIcon className="h-6 w-6 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Ny plattformsadmin</h2>
            <p className="mt-0.5 text-sm text-gray-400">
              Skapar ett super-adminkonto med full åtkomst till plattformen och mailar inloggningsuppgifter.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">E-post <span className="text-indigo-400">*</span></label>
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="namn@meteorpr.se"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Namn</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="t.ex. Kent Karlsson"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50"
            >
              Avbryt
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Skapar…' : 'Skapa plattformsadmin'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PlatformUsers;
