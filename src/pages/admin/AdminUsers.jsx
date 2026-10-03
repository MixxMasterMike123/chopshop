import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { MEMBER_ADMINS, REVOKE_BLOCK, useUsersData } from './adminUsersData';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import {
  Page,
  DataTable,
  StatusPill,
  Button,
  InlineSearch,
  Field,
  Input,
} from '../../components/admin/ui';

// This admin surface lists ADMIN users for the CURRENT shop. Scoping is done by
// AuthContext.getAllUsers(): a shop admin sees only their own shop; a platform
// operator IMPERSONATING a shop sees that shop (impersonation wins); a platform
// admin NOT impersonating sees everyone. (Fixed a cross-shop leak: this page used
// to show every shop's admins while impersonating — see getAllUsers.)
const AdminUsers = () => {
  const { getAllUsers, updateUserRole, updateUserMarginal, inviteAdmin, removeAdmin } = useUsersData();
  // The shop's own admins (the Cloudflare admin build): invite and remove, no
  // roles or margin. The older build keeps its table and its links.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const [users, setUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleUpdateLoading, setRoleUpdateLoading] = useState(false);
  const [marginalUpdateLoading, setMarginalUpdateLoading] = useState(false);
  const [editingMarginals, setEditingMarginals] = useState({});

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const usersList = await getAllUsers();
      setUsers(usersList);
      setFilteredUsers(usersList);
    } catch (error) {
      console.error('Error fetching users:', error);
      toast.error('Kunde inte hämta användare');
    } finally {
      setLoading(false);
    }
  }, [getAllUsers]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // This page manages ADMIN users only (the trade-customer tab was retired in 2026).
  useEffect(() => {
    const term = searchTerm.toLowerCase();
    setFilteredUsers(
      users.filter(
        (user) =>
          user.role === 'admin' &&
          (user.companyName?.toLowerCase().includes(term) ||
            user.email?.toLowerCase().includes(term) ||
            user.contactPerson?.toLowerCase().includes(term)),
      ),
    );
  }, [searchTerm, users]);

  const handleRoleChange = async (userId, currentRole, newRole) => {
    if (currentRole === newRole) return;

    if (window.confirm(`Är du säker på att du vill ändra denna kunds roll till ${newRole === 'admin' ? 'Admin' : 'Kund'}?`)) {
      try {
        setRoleUpdateLoading(true);
        await updateUserRole(userId, newRole);

        // Update the local state after successful role change
        setUsers(prevUsers =>
          prevUsers.map(user =>
            user.id === userId ? { ...user, role: newRole } : user
          )
        );

        toast.success(`Kundroll uppdaterad till ${newRole === 'admin' ? 'Admin' : 'Kund'} framgångsrikt`);
      } catch (error) {
        console.error('Error updating user role:', error);
        toast.error('Kunde inte uppdatera kundroll');
      } finally {
        setRoleUpdateLoading(false);
      }
    }
  };

  const handleMarginalChange = async (userId, newMarginal) => {
    const marginalNum = parseFloat(newMarginal);
    if (isNaN(marginalNum) || marginalNum < 0 || marginalNum > 100) {
      toast.error('Marginal måste vara mellan 0 och 100%');
      return;
    }

    try {
      setMarginalUpdateLoading(true);
      await updateUserMarginal(userId, marginalNum);

      // Update the local state after successful margin change
      setUsers(prevUsers =>
        prevUsers.map(user =>
          user.id === userId ? { ...user, marginal: marginalNum } : user
        )
      );

      // Clear editing state
      setEditingMarginals(prev => {
        const newState = { ...prev };
        delete newState[userId];
        return newState;
      });

    } catch (error) {
      console.error('Error updating user marginal:', error);
      toast.error('Kunde inte uppdatera marginal');
    } finally {
      setMarginalUpdateLoading(false);
    }
  };

  const handleRemove = async (user) => {
    if (user.revokeBlock) return;
    if (!window.confirm(`Ta bort ${user.email} som administratör? Personen förlorar åtkomsten till butikens admin. Kontot raderas inte.`)) return;
    try {
      setRemovingId(user.id);
      await removeAdmin(user.id);
      toast.success(`${user.email} är inte längre administratör`);
      await fetchUsers();
    } catch (error) {
      console.error('Error removing admin:', error);
      toast.error(error?.message || 'Kunde inte ta bort administratören');
    } finally {
      setRemovingId(null);
    }
  };

  const startEditingMarginal = (userId, currentMarginal) => {
    setEditingMarginals(prev => ({
      ...prev,
      [userId]: currentMarginal || 35
    }));
  };

  const cancelEditingMarginal = (userId) => {
    setEditingMarginals(prev => {
      const newState = { ...prev };
      delete newState[userId];
      return newState;
    });
  };

  // ── Table column definitions (Admin Neutral / Shopify IndexTable). ──
  const columns = [
    {
      key: 'user',
      header: MEMBER_ADMINS ? 'Namn & e-post' : 'Företag & Kontakt',
      render: (user) => (
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-admin-border bg-admin-surface-2 text-[12px] font-medium text-admin-text-muted">
            {(user.companyName || user.contactPerson || 'U').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-admin-text">
              {user.companyName || 'Ej angivet'}
            </div>
            <div className="truncate text-[12px] text-admin-text-faint">{user.email}</div>
            {user.contactPerson && (
              <div className="truncate text-[12px] text-admin-text-faint">Kontakt: {user.contactPerson}</div>
            )}
            {user.phone && (
              <div className="truncate text-[12px] text-admin-text-faint">Tel: {user.phone}</div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Roll',
      render: (user) => (
        // Role pill + inline role toggle (stop row click so it doesn't navigate).
        <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
          {user.role === 'admin' ? (
            <StatusPill tone="info">Admin</StatusPill>
          ) : (
            <StatusPill tone="neutral">Kund</StatusPill>
          )}
          <select
            value={user.role}
            onChange={(e) => handleRoleChange(user.id, user.role, e.target.value)}
            disabled={roleUpdateLoading}
            className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] text-admin-text focus:border-admin-text focus:outline-none disabled:opacity-50"
          >
            <option value="user">Kund</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      ),
    },
    {
      key: 'marginal',
      header: 'Marginal',
      align: 'right',
      render: (user) => (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-end gap-2">
          {editingMarginals[user.id] !== undefined ? (
            <>
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={editingMarginals[user.id]}
                onChange={(e) => setEditingMarginals(prev => ({
                  ...prev,
                  [user.id]: e.target.value
                }))}
                className="w-16 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-[12px] tabular-nums text-admin-text focus:border-admin-text focus:outline-none"
                disabled={marginalUpdateLoading}
              />
              <span className="text-[12px] text-admin-text-faint">%</span>
              <button
                type="button"
                onClick={() => handleMarginalChange(user.id, editingMarginals[user.id])}
                disabled={marginalUpdateLoading}
                aria-label="Spara marginal"
                title="Spara marginal"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-text disabled:opacity-50"
              >
                ✓
              </button>
              <button
                type="button"
                onClick={() => cancelEditingMarginal(user.id)}
                disabled={marginalUpdateLoading}
                aria-label="Avbryt"
                title="Avbryt"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot disabled:opacity-50"
              >
                ✕
              </button>
            </>
          ) : (
            <>
              <span className="tabular-nums font-medium text-admin-text">{user.marginal || 35}%</span>
              <Button
                variant="plain"
                size="sm"
                onClick={() => startEditingMarginal(user.id, user.marginal || 35)}
              >
                Ändra
              </Button>
            </>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (user) => (
        <div className="space-y-1">
          {MEMBER_ADMINS && user.invited ? (
            <StatusPill tone="info">Inbjuden</StatusPill>
          ) : MEMBER_ADMINS && user.suspended ? (
            <StatusPill tone="warning">Inaktiv</StatusPill>
          ) : user.active ? (
            <StatusPill tone="success">Aktiv</StatusPill>
          ) : (
            <StatusPill tone="warning">Väntar aktivering</StatusPill>
          )}
          <div className="text-[12px] text-admin-text-faint">
            {MEMBER_ADMINS ? 'Tillagd:' : user.createdByAdmin ? 'Skapad av admin:' : 'Ansökte:'}{' '}
            {user.createdAt ? new Date(user.createdAt).toLocaleDateString('sv-SE') : 'Okänt datum'}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      className: MEMBER_ADMINS ? undefined : 'w-40',
      render: (user) => (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-end gap-2">
          {MEMBER_ADMINS ? (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleRemove(user)}
                disabled={Boolean(user.revokeBlock) || removingId === user.id}
                title={user.revokeBlock ? REVOKE_BLOCK[user.revokeBlock] : undefined}
              >
                Ta bort som administratör
              </Button>
              {user.revokeBlock && (
                <div className="text-right text-[12px] text-admin-text-faint">{REVOKE_BLOCK[user.revokeBlock]}</div>
              )}
            </div>
          ) : (
            <Button as={Link} to={`/admin/users/${user.id}/edit`} variant="secondary" size="sm">
              Redigera
            </Button>
          )}
        </div>
      ),
    },
  ].filter((c) => !MEMBER_ADMINS || (c.key !== 'role' && c.key !== 'marginal'));

  return (
    <AppLayout>
      <Page
        title="Admin Användare"
        back={{ to: '/admin', label: 'Admin Dashboard' }}
        actions={
          MEMBER_ADMINS ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              Bjud in administratör
            </Button>
          ) : (
            <Button as={Link} to="/admin/users/create" variant="primary">
              Skapa Ny Admin
            </Button>
          )
        }
      >
        <DataTable
          columns={columns}
          rows={filteredUsers}
          rowKey={(u) => u.id}
          loading={loading}
          empty="Inga admin användare hittades som matchar dina kriterier."
          toolbar={
            <InlineSearch
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder="Sök efter namn, e-post eller admin…"
            />
          }
        />
      </Page>

      {inviteOpen && (
        <InviteAdminDialog
          onClose={() => setInviteOpen(false)}
          onInvite={inviteAdmin}
          onDone={() => {
            setInviteOpen(false);
            fetchUsers();
          }}
        />
      )}
    </AppLayout>
  );
};

// The invite dialog (the admin build only): two fields, the admin's own modal
// markup and form classes. A refusal stays in the dialog as a sentence.
const InviteAdminDialog = ({ onClose, onInvite, onDone }) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const address = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return setError('Ange en giltig e-postadress.');
    if (name.trim() === '') return setError('Ange ett namn.');
    setSaving(true);
    try {
      await onInvite({ email: address, name: name.trim() });
      toast.success(`Inbjudan skickad till ${address}`);
      onDone();
    } catch (err) {
      if (err?.mailFailed) {
        // The person is added; only the mail failed.
        toast.error(err.message);
        onDone();
        return;
      }
      setError(err?.message || 'Kunde inte bjuda in administratören.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <form onSubmit={submit} className="mt-8 w-full max-w-lg rounded-[var(--radius-admin-card)] bg-admin-surface p-5 shadow-xl">
        <h2 className="mb-4 text-[15px] font-semibold text-admin-text">Bjud in administratör</h2>
        <div className="space-y-4">
          <Field label="Namn" htmlFor="invite-name" required>
            <Input id="invite-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="E-post" htmlFor="invite-email" required help="Personen får en länk för att välja lösenord.">
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Avbryt
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Skickar…' : 'Skicka inbjudan'}
          </Button>
        </div>
      </form>
    </div>
  );
};

export default AdminUsers;
