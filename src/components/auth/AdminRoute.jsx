import React, { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';

// CP13: an affiliate signed in on the admin host belongs in its portal, a
// tree of its own (/affiliate/*, src/admin-app/main.jsx): a full load there,
// never "Du har inte behörighet" and /login. (The older build's context has
// no `accountType`, so nothing changes there.)
function ToAffiliatePortal() {
  useEffect(() => {
    window.location.replace('/affiliate');
  }, []);
  return null;
}

const AdminRoute = ({ children }) => {
  const { currentUser, userProfile, loading, accountType } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <span className="ml-3 text-gray-600">Verifierar behörighet...</span>
      </div>
    );
  }
  
  if (!currentUser) {
    toast.error('Du måste logga in för att komma åt admin-sektionen');
    return <Navigate to="/login" />;
  }
  
  if (accountType === 'affiliate') {
    return <ToAffiliatePortal />;
  }

  if (userProfile?.role !== 'admin') {
    // Redirect to /login (NOT "/") — the root now forwards to /admin, so
    // sending a non-admin there would loop forever.
    toast.error('Du har inte behörighet att komma åt admin-sektionen');
    return <Navigate to="/login" />;
  }

  return children;
};

export default AdminRoute; 