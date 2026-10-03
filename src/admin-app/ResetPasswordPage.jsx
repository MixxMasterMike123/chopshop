// The new password, from the link of the reset mail (CP5 brief FA.5). The API
// sends the link to `<admin origin>/api/auth/reset-password/<token>`, which
// lands here as `/reset-password?token=…` (or `?error=INVALID_TOKEN` when the
// token is unknown or ran out). The page posts the new password to Better
// Auth's reset route and sends the user to /login.
//
// The same surface as LoginPage and ForgotPasswordPage: their wrapper, their
// language switcher, their field group, button, link, error and notice
// blocks, class for class. No new colour, font or spacing. The texts are
// `reset_password.*` keys (not yet in src/locales: the Swedish in the code is
// the fallback, CP5-FA report).

import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import CredentialLanguageSwitcher from '../components/CredentialLanguageSwitcher';
import credentialTranslations from '../utils/credentialTranslations';

// Better Auth's minimum and maximum (create-auth.ts keeps its defaults).
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

function readLink(search) {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  return {
    token: token && /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null,
    linkError: params.get('error'),
  };
}

const ResetPasswordPage = () => {
  const { confirmPasswordReset } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // The token stays in the address, so a reload keeps the page working. It is
  // single-use and runs out in an hour; the admin Worker's Referrer-Policy
  // (same-origin) keeps it from any other origin.
  const [{ token, linkError }] = useState(() => readLink(location.search));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [currentLanguage, setCurrentLanguage] = useState(credentialTranslations.getStoredLanguage());
  const [translationsLoaded, setTranslationsLoaded] = useState(false);

  useEffect(() => {
    const loadTranslations = async () => {
      await credentialTranslations.setLanguage(currentLanguage);
      setTranslationsLoaded(true);
    };
    loadTranslations();
  }, [currentLanguage]);

  const handleLanguageChange = async (languageCode) => {
    setTranslationsLoaded(false);
    setCurrentLanguage(languageCode);
  };

  const t = (key, fallback = null) => credentialTranslations.t(key, fallback);

  const linkIsValid = token !== null && !linkError;

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!password || !confirm) {
      return setError(t('reset_password.errors.fill_all_fields', 'Fyll i båda fälten'));
    }
    if (password.length < MIN_LENGTH) {
      return setError(t('reset_password.errors.too_short', `Lösenordet måste vara minst ${MIN_LENGTH} tecken`));
    }
    if (password.length > MAX_LENGTH) {
      return setError(t('reset_password.errors.too_long', `Lösenordet får vara högst ${MAX_LENGTH} tecken`));
    }
    if (password !== confirm) {
      return setError(t('reset_password.errors.mismatch', 'Lösenorden matchar inte'));
    }

    try {
      setError('');
      setLoading(true);
      await confirmPasswordReset(token, password);
      toast.success(t('reset_password.success', 'Lösenordet är bytt. Logga in med det nya lösenordet.'));
      navigate('/login', { replace: true });
    } catch (err) {
      if (err?.code === 'INVALID_TOKEN') {
        setError(t('reset_password.errors.invalid_link', 'Länken är ogiltig eller har gått ut. Begär en ny.'));
      } else if (err?.code === 'PASSWORD_TOO_SHORT' || err?.code === 'PASSWORD_TOO_LONG') {
        setError(t('reset_password.errors.too_short', `Lösenordet måste vara minst ${MIN_LENGTH} tecken`));
      } else if (err?.code === 'rate_limited') {
        setError(t('reset_password.errors.rate_limited', 'För många försök. Vänta en stund och försök igen.'));
      } else {
        setError(t('reset_password.errors.failed', 'Lösenordet kunde inte bytas. Försök igen.'));
      }
    } finally {
      setLoading(false);
    }
  };

  if (!translationsLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        {/* Language Switcher */}
        <div className="flex justify-end">
          <CredentialLanguageSwitcher
            currentLanguage={currentLanguage}
            onLanguageChange={handleLanguageChange}
          />
        </div>

        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            {t('reset_password.title', 'Välj nytt lösenord')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            {linkIsValid
              ? t('reset_password.subtitle', `Ange ditt nya lösenord, minst ${MIN_LENGTH} tecken`)
              : t('reset_password.invalid_subtitle', 'Länken i mejlet fungerar inte längre')}
          </p>
        </div>

        {!linkIsValid && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4">
            <p className="text-red-700">
              {t('reset_password.errors.invalid_link', 'Länken är ogiltig eller har gått ut. Begär en ny.')}
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4">
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {linkIsValid ? (
          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            <div className="rounded-md shadow-xs -space-y-px">
              <div>
                <label htmlFor="new-password" className="sr-only">
                  {t('reset_password.fields.password', 'Nytt lösenord')}
                </label>
                <input
                  id="new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                  placeholder={t('reset_password.placeholders.password', 'Nytt lösenord')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="sr-only">
                  {t('reset_password.fields.confirm', 'Upprepa lösenordet')}
                </label>
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                  placeholder={t('reset_password.placeholders.confirm', 'Upprepa lösenordet')}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                {loading ? t('reset_password.button.saving', 'Sparar...') : t('reset_password.button.save', 'Spara nytt lösenord')}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div className="text-sm">
                <Link to="/login" className="font-medium text-primary-600 hover:text-primary-500">
                  {t('reset_password.back_to_login', 'Tillbaka till inloggningen')}
                </Link>
              </div>
            </div>
          </form>
        ) : (
          <div className="mt-8 flex items-center justify-between">
            <div className="text-sm">
              <Link to="/forgot-password" className="font-medium text-primary-600 hover:text-primary-500">
                {t('reset_password.request_new', 'Begär en ny länk')}
              </Link>
            </div>
            <div className="text-sm">
              <Link to="/login" className="font-medium text-primary-600 hover:text-primary-500">
                {t('reset_password.back_to_login', 'Tillbaka till inloggningen')}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ResetPasswordPage;
