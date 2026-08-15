// WagonRegistry.js - Central wagon discovery and registration system
// This is the "train coupling" system that connects wagons to the main B8Shield train

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase/config.js';

class WagonRegistry {
  constructor() {
    this.wagons = new Map(); // Only enabled wagons
    this.allWagons = new Map(); // All discovered wagons (enabled + disabled)
    this.initialized = false;
    this.isDiscovering = false; // Prevent concurrent discovery
  }

  /**
   * PERFORMANCE OPTIMIZATION: Check if wagon discovery is needed
   * Skip discovery for B2C mode since wagons are primarily B2B/admin tools
   */
  shouldDiscoverWagons() {
    // Check if we're on B2C shop domain
    const sub = typeof window !== 'undefined'
      ? (window.location.hostname || '').split('.')[0]
      : '';
    const isB2CShop = sub === 'shop' || sub.startsWith('shop-');
    
    // Check URL path for admin routes
    const isAdminRoute = typeof window !== 'undefined' && 
                        window.location.pathname.startsWith('/admin');
    
    // Check if we're in an environment where wagons would be used
    const needsWagons = !isB2CShop || isAdminRoute;
    
    if (!needsWagons) {
      console.log('⚡ Skipping wagon discovery for B2C mode (performance optimization)');
      return false;
    }
    
    return true;
  }

  /**
   * Auto-discover and register all wagons
   * This is the ONLY method the core app needs to call
   * PERFORMANCE OPTIMIZED: Only runs when wagons are actually needed
   */
  async discoverWagons() {
    if (this.initialized) return;
    
    // Check if discovery is needed (performance optimization)
    if (!this.shouldDiscoverWagons()) {
      this.initialized = true; // Mark as initialized to prevent future attempts
      return;
    }
    
    // Prevent concurrent discovery
    if (this.isDiscovering) {
      console.log('🚂 B8Shield Train: Already discovering wagons, skipping...');
      return;
    }
    
    this.isDiscovering = true;
    console.log('🚂 B8Shield Train: Discovering wagons...');

    try {
      // Auto-discover wagon directories
      const wagonModules = import.meta.glob('./*/index.js');
      
      for (const [path, importFn] of Object.entries(wagonModules)) {
        try {
          const wagonModule = await importFn();
          const wagon = wagonModule.default || wagonModule;
          
          if (wagon && wagon.manifest) {
            await this.registerWagon(wagon);
          }
        } catch (error) {
          console.warn(`⚠️ Failed to load wagon from ${path}:`, error);
        }
      }

      this.initialized = true;
      console.log(`✅ B8Shield Train: ${this.wagons.size} wagons connected, ${this.allWagons.size} total discovered`);
      
    } catch (error) {
      console.error('❌ B8Shield Train: Wagon discovery failed:', error);
    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * PERFORMANCE OPTIMIZATION: Lazy wagon discovery
   * Only discovers wagons when they're actually requested
   */
  async ensureWagonsDiscovered() {
    if (!this.initialized && !this.isDiscovering) {
      await this.discoverWagons();
    }
  }

  /**
   * Register a single wagon
   */
  async registerWagon(wagon) {
    const { manifest } = wagon;
    
    // Validate wagon manifest
    if (!this.validateWagon(manifest)) {
      console.error(`❌ Invalid wagon manifest:`, manifest);
      return false;
    }

    const wagonWithMetadata = {
      ...wagon,
      registeredAt: new Date().toISOString()
    };

    // Always store in allWagons for admin purposes
    this.allWagons.set(manifest.id, wagonWithMetadata);

    // Check if wagon is enabled for active registration
    if (!manifest.enabled) {
      console.log(`⏸️ Wagon '${manifest.name}' is disabled, stored for admin access only`);
      return false;
    }

    // Register the wagon for active use
    this.wagons.set(manifest.id, wagonWithMetadata);

    console.log(`🔗 Connected wagon: ${manifest.name} v${manifest.version}`);
    return true;
  }

  /**
   * Validate wagon manifest structure
   */
  validateWagon(manifest) {
    const required = ['id', 'name', 'version', 'type', 'enabled'];
    
    for (const field of required) {
      if (!manifest[field]) {
        console.error(`❌ Missing required field '${field}' in wagon manifest`);
        return false;
      }
    }

    // ID validation
    if (!/^[a-z0-9-]+$/.test(manifest.id)) {
      console.error(`❌ Invalid wagon ID format: ${manifest.id}`);
      return false;
    }

    // Version validation
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      console.error(`❌ Invalid version format: ${manifest.version}`);
      return false;
    }

    return true;
  }

  /**
   * Get wagon by ID
   */
  getWagon(wagonId) {
    return this.wagons.get(wagonId);
  }

  /**
   * Get all wagons (enabled only)
   */
  getAllWagons() {
    return this.allWagons;
  }

  /**
   * Check if wagon exists and is enabled
   */
  hasWagon(wagonId) {
    return this.wagons.has(wagonId);
  }

  /**
   * Get wagon service/API
   */
  getWagonService(wagonId, serviceName) {
    const wagon = this.getWagon(wagonId);
    if (!wagon || !wagon.services) return null;
    
    return wagon.services[serviceName];
  }

  /**
   * Get wagon statistics
   */
  getStats() {
    return {
      total: this.allWagons.size,
      enabled: this.wagons.size,
      disabled: this.allWagons.size - this.wagons.size,
      initialized: this.initialized,
      isDiscovering: this.isDiscovering
    };
  }

  /**
   * Get all admin menu items from wagons (with user permission check)
   * Core app calls this to build navigation
   * PERFORMANCE OPTIMIZED: Only discovers wagons when needed
   */
  async getAdminMenuItems(userId = null) {
    await this.ensureWagonsDiscovered();
    
    const menuItems = [];
    
    for (const wagon of this.wagons.values()) {
      if (wagon.manifest.adminMenu) {
        // Check if wagon is enabled for user
        if (userId) {
          const isEnabled = await this.isWagonEnabledForUser(wagon.manifest.id, userId);
          if (!isEnabled) continue;
        }
        
        menuItems.push({
          ...wagon.manifest.adminMenu,
          wagonId: wagon.manifest.id,
          component: wagon.AdminComponent
        });
      }
    }

    return menuItems.sort((a, b) => (a.order || 999) - (b.order || 999));
  }

  /**
   * Sync version of getAdminMenuItems (for AppLayout fallback)
   * Returns all admin menu items without permission checking
   */
  getAdminMenuItemsSync() {
    const menuItems = [];
    
    for (const wagon of this.wagons.values()) {
      if (wagon.manifest.adminMenu) {
        menuItems.push({
          ...wagon.manifest.adminMenu,
          wagonId: wagon.manifest.id,
          component: wagon.AdminComponent
        });
      }
    }

    return menuItems.sort((a, b) => (a.order || 999) - (b.order || 999));
  }

  /**
   * Get user menu items from wagons (for regular user navigation)
   * Returns empty array for now - wagons are primarily admin tools
   */
  getUserMenuItemsSync() {
    // Wagons are primarily admin tools, so return empty array for regular users
    return [];
  }

  /**
   * Check if wagon is enabled for specific user
   * SECURITY: Wagons are disabled by default, only enabled for admins or explicit settings
   */
  async isWagonEnabledForUser(wagonId, userId) {
    if (!userId) return false;
    
    try {
      // Check if user is admin first
      const userDoc = await getDoc(doc(db, 'users', userId));
      if (!userDoc.exists()) return false;
      
      const userData = userDoc.data();
      const isAdmin = userData.role === 'admin';
      
      // Check explicit wagon settings for this user
      const settingsDoc = await getDoc(doc(db, 'userWagonSettings', userId));
      
      if (!settingsDoc.exists()) {
        // No settings exist - use default behavior
        return isAdmin; // Admins get access by default, non-admins don't
      }
      
      const settings = settingsDoc.data();
      if (!settings || !settings.wagons) {
        // No wagon settings - use default behavior
        return isAdmin; // Admins get access by default, non-admins don't
      }
      
      const wagonSetting = settings.wagons[wagonId];
      
      // If explicit setting exists, use it (even for admins)
      if (wagonSetting !== undefined) {
        return wagonSetting?.enabled === true;
      }
      
      // No explicit setting - use default behavior
      return isAdmin; // Admins get access by default, non-admins don't
      
    } catch (error) {
      console.warn('Error checking wagon user settings:', error);
      return false; // Default: disabled on error (secure default)
    }
  }

  /**
   * Get all routes from wagons
   * Core app calls this to register routes
   * PERFORMANCE OPTIMIZED: Only discovers wagons when needed
   */
  async getRoutes() {
    await this.ensureWagonsDiscovered();
    
    const routes = [];
    
    for (const wagon of this.wagons.values()) {
      if (wagon.manifest.routes) {
        wagon.manifest.routes.forEach(route => {
          routes.push({
            ...route,
            wagonId: wagon.manifest.id,
            component: wagon.components[route.component]
          });
        });
      }
    }

    return routes;
  }

  /**
   * Get routes for specific user (with permission checking)
   * App.jsx can call this to register routes based on user permissions
   * PERFORMANCE OPTIMIZED: Only discovers wagons when needed
   */
  async getRoutesForUser(userId) {
    await this.ensureWagonsDiscovered();
    
    const routes = [];
    
    for (const wagon of this.wagons.values()) {
      if (wagon.manifest.routes) {
        // Check if wagon is enabled for user
        const isEnabled = await this.isWagonEnabledForUser(wagon.manifest.id, userId);
        if (!isEnabled) continue;
        
        wagon.manifest.routes.forEach(route => {
          routes.push({
            ...route,
            wagonId: wagon.manifest.id,
            component: wagon.components[route.component]
          });
        });
      }
    }

    return routes;
  }

  /**
   * Get all wagons for admin management
   * Used by AdminSettings to show all wagons (enabled + disabled)
   */
  async getAllWagonsForAdmin() {
    await this.ensureWagonsDiscovered();
    return this.allWagons;
  }

  /**
   * Force wagon discovery (for testing/debugging)
   */
  async forceDiscoverWagons() {
    this.initialized = false;
    this.isDiscovering = false;
    this.wagons.clear();
    this.allWagons.clear();
    await this.discoverWagons();
  }

  /**
   * Clear all wagons (for testing)
   */
  clearWagons() {
    this.wagons.clear();
    this.allWagons.clear();
    this.initialized = false;
    this.isDiscovering = false;
  }
}

// Export singleton instance
const wagonRegistry = new WagonRegistry();
export default wagonRegistry; 