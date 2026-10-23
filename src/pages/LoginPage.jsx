import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import CredentialLanguageSwitcher from '../components/CredentialLanguageSwitcher';
import credentialTranslations from '../utils/credentialTranslations';

const LoginPage = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Default post-login destination is surface-aware: on the platform operator
  // host, '/' renders the platform console; elsewhere it's the admin console.
  const sub = (typeof window !== 'undefined' ? window.location.hostname : '').split('.')[0];
  const isPlatformHost = sub === 'platform' || sub.startsWith('platform-');
  const defaultDest = isPlatformHost ? '/' : '/admin';
  const from = location.state?.from?.pathname || defaultDest;
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const initialLanguage = credentialTranslations.getStoredLanguage();
  console.log(`🔐 LOGIN PAGE: Initial language detected: ${initialLanguage}`);
  const [currentLanguage, setCurrentLanguage] = useState(initialLanguage);
  const [translationsLoaded, setTranslationsLoaded] = useState(false);

  // Load translations on component mount and language change
  useEffect(() => {
    const loadTranslations = async () => {
      await credentialTranslations.setLanguage(currentLanguage);
      setTranslationsLoaded(true);
    };
    
    loadTranslations();
  }, [currentLanguage]);

  const handleLanguageChange = async (languageCode) => {
    setTranslationsLoaded(false);  // Show loading state during switch
    setCurrentLanguage(languageCode);
    // Let useEffect handle the translation loading
  };

  const t = (key, fallback = null) => {
    return credentialTranslations.t(key, fallback);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!email || !password) {
      return setError(t('login.errors.fill_all_fields', 'Please fill in all fields'));
    }
    
    try {
      setError('');
      setLoading(true);
      await login(email, password);
      navigate(from, { replace: true });
    } catch (error) {
      setError(t('login.errors.invalid_credentials', 'Failed to log in. Please check your credentials.'));
    } finally {
      setLoading(false);
    }
  };

  // Show loading state until translations are loaded
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
          {/* Platform wordmark (Flippin Stuff, 2026-10-23: the working logo
              until a vector version exists). The login is the platform's
              door, so it carries the platform brand, never a shop's. */}
          <img
            src="/images/flippin-stuff-logo.jpg"
            alt="Flippin Stuff"
            width="1400"
            height="964"
            className="mx-auto h-28 w-auto"
          />
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            {t('login.title', 'Sign in to your account')}
          </h2>
        </div>
        
        {error && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4">
            <p className="text-red-700">{error}</p>
          </div>
        )}
        
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <input type="hidden" name="remember" defaultValue="true" />
          <div className="rounded-md shadow-xs -space-y-px">
            <div>
              <label htmlFor="email-address" className="sr-only">
                {t('login.fields.email', 'Email address')}
              </label>
              <input
                id="email-address"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                placeholder={t('login.placeholders.email', 'Email address')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                {t('login.fields.password', 'Password')}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                placeholder={t('login.placeholders.password', 'Password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <input
                id="remember-me"
                name="remember-me"
                type="checkbox"
                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded-sm"
              />
              <label htmlFor="remember-me" className="ml-2 block text-sm text-gray-900">
                {t('login.remember_me', 'Remember me')}
              </label>
            </div>

            <div className="text-sm">
              <Link to="/forgot-password" className="font-medium text-primary-600 hover:text-primary-500">
                {t('login.forgot_password', 'Forgot your password?')}
              </Link>
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
            >
              {loading ? t('login.button.signing_in', 'Signing in...') : t('login.button.sign_in', 'Sign in')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default LoginPage; 