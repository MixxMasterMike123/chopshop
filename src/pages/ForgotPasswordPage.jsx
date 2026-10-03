import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSimpleAuth } from '../contexts/SimpleAuthContext';
import CredentialLanguageSwitcher from '../components/CredentialLanguageSwitcher';
import credentialTranslations from '../utils/credentialTranslations';

const ForgotPasswordPage = () => {
  const { resetPassword } = useSimpleAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [currentLanguage, setCurrentLanguage] = useState(credentialTranslations.getStoredLanguage());
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
    
    if (!email) {
      return setError(t('forgot_password.errors.enter_email', 'Please enter your email address'));
    }
    
    try {
      setError('');
      setMessage('');
      setLoading(true);
      
      await resetPassword(email);
      setMessage(t('forgot_password.success.check_email', 'Check your email for instructions to reset your password'));
      setEmail('');
    } catch (error) {
      setError(t('forgot_password.errors.reset_failed', 'Failed to reset password. Please check if your email is correct.'));
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
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            {t('forgot_password.title', 'Reset Password')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            {t('forgot_password.subtitle', 'Enter your email address and we\'ll send you a link to reset your password')}
          </p>
        </div>
        
        {error && (
          <div className="bg-red-50 border-l-4 border-red-400 p-4">
            <p className="text-red-700">{error}</p>
          </div>
        )}
        
        {message && (
          <div className="bg-green-50 border-l-4 border-green-400 p-4">
            <p className="text-green-700">{message}</p>
          </div>
        )}
        
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-xs -space-y-px">
            <div>
              <label htmlFor="email-address" className="sr-only">
                {t('forgot_password.fields.email', 'Email address')}
              </label>
              <input
                id="email-address"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-hidden focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                placeholder={t('forgot_password.placeholders.email', 'Email address')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
            >
              {loading ? t('forgot_password.button.processing', 'Processing...') : t('forgot_password.button.reset', 'Reset Password')}
            </button>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <Link to="/login" className="font-medium text-primary-600 hover:text-primary-500">
                {t('forgot_password.back_to_login', 'Back to login')}
              </Link>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ForgotPasswordPage; 