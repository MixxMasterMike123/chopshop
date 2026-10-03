// AddShopUserModal — P4.6: a platform operator adds a SHOP ADMIN to a tenant.
// Calls the platform-gated createShopUser callable (creates the Auth account +
// users/{uid} doc + claims + credentials email). The new admin logs in at the
// admin host and useShopId() resolves to their shop (config/activeShop.js).
import React, { useState } from 'react';
import { NAME_FIELD, addShopUser } from './addShopUserData';
import toast from 'react-hot-toast';
import { UserPlusIcon } from '@heroicons/react/24/outline';

const AddShopUserModal = ({ shop, onClose }) => {
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
      const data = await addShopUser({ shop, email: trimmed, name });
      if (data.emailSent) {
        toast.success(`Admin tillagd för ${shop.name || shop.id}. Inloggningsuppgifter skickade till ${trimmed}.`);
      } else {
        // Account was created but the email didn't go out — surface clearly so
        // the operator knows to send credentials another way.
        toast(`Admin skapad men e-post misslyckades${data.emailError ? `: ${data.emailError}` : ''}. Skicka uppgifter manuellt.`, { icon: '⚠️' });
      }
      onClose?.();
    } catch (err) {
      console.error('createShopUser failed:', err);
      setError(err?.message || 'Kunde inte lägga till användaren.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-gray-900 border border-white/10 shadow-2xl text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-white/10 px-6 py-5">
          <div className="rounded-lg bg-indigo-500/15 p-2">
            <UserPlusIcon className="h-6 w-6 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Lägg till admin</h2>
            <p className="mt-0.5 text-sm text-gray-400">
              Skapar ett administratörskonto för{' '}
              <span className="font-medium text-gray-200">{shop.name || shop.id}</span> och mailar
              inloggningsuppgifter.
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
              placeholder="namn@butik.se"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </div>
          {NAME_FIELD && <div>
            <label className="block text-sm text-gray-400 mb-1">Namn</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="t.ex. Anna Andersson"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </div>}

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
              {saving ? 'Skapar…' : 'Lägg till admin'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddShopUserModal;
