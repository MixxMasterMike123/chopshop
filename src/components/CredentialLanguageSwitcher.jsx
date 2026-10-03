/**
 * Credential Language Switcher Component
 * 
 * A standalone language switcher for credential pages (login, register, forgot password)
 * that works independently of the main TranslationContext since users aren't logged in yet.
 * Stores language preference in localStorage and cookies for persistence.
 */

import React, { useState, useEffect } from 'react';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
// Where the choice is kept is data: the Cloudflare admin build swaps this
// module (alias list).
import { rememberCredentialLanguage } from '../utils/credentialLanguageStorage';

const CredentialLanguageSwitcher = ({ currentLanguage, onLanguageChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  
  const languages = [
    { code: 'sv-SE', name: 'Svenska', flag: '🇸🇪' },
    { code: 'en-GB', name: 'English', flag: '🇬🇧' }
  ];

  const currentLang = languages.find(lang => lang.code === currentLanguage) || languages[0];

  const handleLanguageChange = (languageCode) => {
    rememberCredentialLanguage(languageCode);

    onLanguageChange(languageCode);
    setIsOpen(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.language-switcher')) {
        setIsOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  return (
    <div className="relative language-switcher">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 px-3 py-2 border border-gray-300 rounded-md bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
      >
        <span className="text-lg">{currentLang.flag}</span>
        <span>{currentLang.name}</span>
        <ChevronDownIcon className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg border border-gray-200 z-50">
          <div className="py-1">
            {languages.map((language) => (
              <button
                key={language.code}
                onClick={() => handleLanguageChange(language.code)}
                className={`w-full text-left px-4 py-2 text-sm flex items-center space-x-3 hover:bg-gray-50 ${
                  currentLanguage === language.code ? 'bg-blue-50 text-blue-600' : 'text-gray-700'
                }`}
              >
                <span className="text-lg">{language.flag}</span>
                <span className="flex-1">{language.name}</span>
                {currentLanguage === language.code && (
                  <CheckIcon className="h-4 w-4 text-blue-600" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default CredentialLanguageSwitcher; 