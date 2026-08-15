import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { 
  collection, 
  addDoc, 
  updateDoc, 
  getDoc, 
  getDocs, 
  doc, 
  query, 
  where, 
  orderBy,
  limit,
  deleteDoc,
  Timestamp,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';
import { db, isDemoMode } from '../firebase/config';
import { functionUrl } from '../config/urls';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from './AuthContext';
import { useShopId } from './ShopContext';
import { withShopId } from '../config/withShopId';
import toast from 'react-hot-toast';
import { onOrderCompleted } from '../wagons/dining-wagon/utils/customerStatusAutomation';
import { useShopFeatures } from './ShopFeaturesContext';

// Create context
const OrderContext = createContext();

// Demo mode mock orders
const DEMO_ORDERS = [
  {
    id: 'order-1',
    orderNumber: 'B8-20230110-1234',
    userId: 'admin-user-1',
    companyName: 'B8shield Admin',
    customerName: 'Client A',
    customerEmail: 'clienta@example.com',
    items: [
      { productId: 'prod-1', name: 'Product A', quantity: 2, price: 100 },
      { productId: 'prod-2', name: 'Product B', quantity: 3, price: 150 }
    ],
    totalPrice: 650,
    status: 'delivered',
    createdAt: '2023-01-10T10:30:00.000Z',
    updatedAt: '2023-01-15T14:20:00.000Z'
  },
  {
    id: 'order-2',
    orderNumber: 'B8-20230215-5678',
    userId: 'user-1',
    companyName: 'Company A',
    customerName: 'Client B',
    customerEmail: 'clientb@example.com',
    items: [
      { productId: 'prod-1', name: 'Product A', quantity: 1, price: 100 },
      { productId: 'prod-3', name: 'Product C', quantity: 2, price: 200 }
    ],
    totalPrice: 500,
    status: 'processing',
    createdAt: '2023-02-15T09:45:00.000Z',
    updatedAt: '2023-02-16T11:30:00.000Z'
  },
  {
    id: 'order-3',
    orderNumber: 'B8-20230301-9012',
    userId: 'user-1',
    companyName: 'Company A',
    customerName: 'Client C',
    customerEmail: 'clientc@example.com',
    items: [
      { productId: 'prod-2', name: 'Product B', quantity: 4, price: 150 }
    ],
    totalPrice: 600,
    status: 'pending',
    createdAt: '2023-03-01T15:20:00.000Z',
    updatedAt: '2023-03-01T15:20:00.000Z'
  },
  {
    id: 'order-4',
    orderNumber: 'B8-20230305-3456',
    userId: 'user-2',
    companyName: 'Company B',
    customerName: 'Client D',
    customerEmail: 'clientd@example.com',
    items: [
      { productId: 'prod-1', name: 'Product A', quantity: 3, price: 100 },
      { productId: 'prod-2', name: 'Product B', quantity: 2, price: 150 },
      { productId: 'prod-3', name: 'Product C', quantity: 1, price: 200 }
    ],
    totalPrice: 800,
    status: 'shipped',
    createdAt: '2023-03-05T13:10:00.000Z',
    updatedAt: '2023-03-07T09:15:00.000Z'
  },
  {
    id: 'order-5',
    orderNumber: 'B8-20230312-7890',
    userId: 'admin-user-1',
    companyName: 'B8shield Admin',
    customerName: 'Client E',
    customerEmail: 'cliente@example.com',
    items: [
      { productId: 'prod-3', name: 'Product C', quantity: 5, price: 200 }
    ],
    totalPrice: 1000,
    status: 'pending',
    createdAt: '2023-03-12T16:40:00.000Z',
    updatedAt: '2023-03-12T16:40:00.000Z'
  }
];

// Provider component
export const OrderProvider = ({ children }) => {
  const { currentUser, isAdmin, isPlatform } = useAuth();
  const shopId = useShopId();
  // Dining add-on gate (default-ON). OrderProvider sits inside
  // ShopFeaturesProvider (App.jsx), so the hook is available; referenced in the
  // updateOrderStatus callback below for the dining automation.
  const { isEnabled: isAddonEnabled } = useShopFeatures();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [demoOrders, setDemoOrders] = useState(DEMO_ORDERS);

  // Product constants - in a real app, these would come from Firestore settings
  const PRODUCT_SETTINGS = {
    FORSALJNINGSPRIS_INKL_MOMS: 89, // kr per förpackning inkl moms
    TILLVERKNINGSKOSTNAD: 10, // kr per förpackning
    DEFAULT_MARGINAL: 35 // Default margin percentage
  };

  // B2B order creation removed (B2B→B2C collapse). Orders are created
  // server-side by the Stripe webhook; this context only reads/updates.

  // Get an order by ID
  const getOrderById = useCallback(async (orderId) => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      
      if (isDemoMode) {
        // Demo mode: mock order retrieval
        const order = demoOrders.find(o => o.id === orderId);
        
        if (!order) {
          setError('Order not found');
          return null;
        }
        
        // Check if user is authorized to view this order
        if (order.userId !== currentUser.uid && !isAdmin) {
          setError('Unauthorized');
          return null;
        }
        
        return order;
      } else {
        // Only try to get the order from named database 
        try {
          const orderDoc = await getDoc(doc(db, "orders", orderId));
          
          if (orderDoc.exists()) {
            const orderData = orderDoc.data();
            
            // Authorization (mirrors the firestore.rules orders-list scoping —
            // the `allow get: if true` rule can't enforce tenancy, so it MUST be
            // enforced here): the owner sees their own order; a PLATFORM admin
            // sees any shop's; a SHOP admin sees ONLY their own shop's order.
            // Without the shopId match a shopA admin could load shopB's order by
            // ID (cross-tenant PII leak) — the go-live audit's one real hole.
            const isOwner = orderData.userId === currentUser.uid;
            const isAdminOfThisShop = isAdmin && (isPlatform || orderData.shopId === shopId);
            if (!isOwner && !isAdminOfThisShop) {
              setError('Order not found');
              return null;
            }
            
            // Process any timestamps to avoid re-render loops
            const processedData = processTimestamps(orderData);
            
            return {
              id: orderDoc.id,
              ...processedData
            };
          } else {
            // If we reach here, the order was not found
            setError('Order not found');
            return null;
          }
        } catch (firestoreError) {
          console.error('Error fetching from Firestore:', firestoreError);
          setError(`Error fetching order: ${firestoreError.message}`);
          return null;
        }
      }
    } catch (error) {
      console.error('Error in getOrderById:', error);
      setError(error.message || 'Error fetching order');
      return null;
    } finally {
      setLoading(false);
    }
  }, [currentUser, demoOrders, isAdmin, isPlatform, shopId]);

  // Helper function to process Firestore timestamps to stable format
  // This prevents re-render loops caused by timestamp objects changing identity
  const processTimestamps = (data) => {
    if (!data) return data;
    
    const processed = { ...data };
    
    // Process common timestamp fields
    const timestampFields = ['createdAt', 'updatedAt', 'cancelledAt'];
    
    timestampFields.forEach(field => {
      if (processed[field] && typeof processed[field].toDate === 'function') {
        // Convert to ISO string for stability
        processed[field] = processed[field].toDate().toISOString();
      }
    });
    
    // Process status history array if it exists
    if (Array.isArray(processed.statusHistory)) {
      processed.statusHistory = processed.statusHistory.map(entry => {
        const processedEntry = { ...entry };
        if (processedEntry.changedAt && typeof processedEntry.changedAt.toDate === 'function') {
          processedEntry.changedAt = processedEntry.changedAt.toDate().toISOString();
        }
        return processedEntry;
      });
    }
    
    return processed;
  };

  // Get user's orders
  const getUserOrders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      
      if (isDemoMode) {
        // Demo mode: mock user orders
        const userOrders = demoOrders.filter(order => order.userId === currentUser.uid);
        return userOrders;
      } else {
        const orders = [];
        
        // Only use named database
        try {
          const ordersQuery = query(
            collection(db, "orders"),
            where("shopId", "==", shopId),
            where("userId", "==", currentUser.uid),
            orderBy("createdAt", "desc")
          );

          const querySnapshot = await getDocs(ordersQuery);
          
          querySnapshot.forEach((doc) => {
            orders.push({
              id: doc.id,
              ...doc.data()
            });
          });
        } catch (error) {
          console.error('Error fetching orders from named database:', error);
        }
        
        return orders;
      }
    } catch (error) {
      setError(error.message);
      console.error('Error in getUserOrders:', error);
      // Return empty array instead of throwing to prevent loops
      return [];
    } finally {
      setLoading(false);
    }
  }, [currentUser, demoOrders, shopId]);

  // Get recent orders
  const getRecentOrders = useCallback(async (limitCount = 5) => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      
      if (isDemoMode) {
        // Demo mode: mock recent orders
        if (isAdmin) {
          // Admin can see all orders
          return demoOrders.slice(0, limitCount);
        } else {
          // Regular users only see their own orders
          return demoOrders
            .filter(order => order.userId === currentUser.uid)
            .slice(0, limitCount);
        }
      } else {
        // Real Firebase recent orders
        let ordersQuery;
        
        if (isAdmin) {
          // Admin can see all orders for THIS shop
          ordersQuery = query(
            collection(db, "orders"),
            where("shopId", "==", shopId),
            orderBy("createdAt", "desc"),
            limit(limitCount)
          );
        } else {
          // Regular users only see their own orders
          ordersQuery = query(
            collection(db, "orders"),
            where("shopId", "==", shopId),
            where("userId", "==", currentUser.uid),
            orderBy("createdAt", "desc"),
            limit(limitCount)
          );
        }
        
        const querySnapshot = await getDocs(ordersQuery);
        const orders = [];
        
        querySnapshot.forEach((doc) => {
          orders.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        return orders;
      }
    } catch (error) {
      setError(error.message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [currentUser, isAdmin, demoOrders, shopId]);

  // Get all orders (admin only)
  const getAllOrders = useCallback(async () => {
    try {
      console.log('getAllOrders: Starting to fetch orders');
      setLoading(true);
      setError(null);
      
      if (!currentUser) {
        console.log('getAllOrders: No authenticated user');
        throw new Error('No authenticated user');
      }
      
      if (!isAdmin) {
        console.log('getAllOrders: User is not admin');
        throw new Error('Unauthorized');
      }
      
      console.log('getAllOrders: Auth checks passed, isDemoMode:', isDemoMode);
      
      if (isDemoMode) {
        // Demo mode: return all mock orders
        console.log('getAllOrders: Returning demo orders', demoOrders.length);
        return demoOrders;
      } else {
        // Real Firebase all orders - only from named database
        console.log('getAllOrders: Fetching from Firestore');
        
        try {
          // Only use the named database
          console.log('getAllOrders: Fetching from named database (b8s-reseller-db)');
          const namedDbOrdersQuery = query(
            collection(db, "orders"),
            where("shopId", "==", shopId),
            orderBy("createdAt", "desc")
          );
          
          const namedDbSnapshot = await getDocs(namedDbOrdersQuery);
          const namedDbOrders = [];
          
          namedDbSnapshot.forEach((doc) => {
            namedDbOrders.push({
              id: doc.id,
              ...doc.data()
            });
          });
          
          console.log('getAllOrders: Retrieved', namedDbOrders.length, 'orders from named database');
          return namedDbOrders;
        } catch (firestoreError) {
          console.error('getAllOrders: Firestore error:', firestoreError);
          throw firestoreError;
        }
      }
    } catch (error) {
      console.error('getAllOrders: Error:', error);
      setError(error.message);
      throw error;
    } finally {
      console.log('getAllOrders: Setting loading to false');
      setLoading(false);
    }
  }, [currentUser, isAdmin, demoOrders, shopId]);

  // Update order status (admin only)
  const updateOrderStatus = useCallback(async (orderId, newStatus, additionalData = {}) => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      if (!isAdmin) throw new Error('Unauthorized');
      
      if (isDemoMode) {
        // Get current order to check previous status
        const currentOrder = demoOrders.find(order => order.id === orderId);
        const previousStatus = currentOrder?.status || 'unknown';
        
        // Create status history entry
        const statusChange = {
          from: previousStatus,
          to: newStatus,
          changedBy: currentUser.uid,
          changedAt: serverTimestamp(),
          displayName: currentUser.displayName || 'Admin User'
        };
        
        // Update order with new status and add to status history
        setDemoOrders(orders => 
          orders.map(order => 
            order.id === orderId 
              ? { 
                  ...order, 
                  status: newStatus, 
                  updatedAt: new Date().toISOString(),
                  statusHistory: [...(order.statusHistory || []), {
                    ...statusChange,
                    changedAt: new Date().toISOString() // Convert to ISO string for demo mode
                  }],
                  ...additionalData // Include tracking number, carrier, admin notes, etc.
                } 
              : order
          )
        );
        
        toast.success(`Order status updated to ${newStatus} (Demo Mode)`);
        return true;
      } else {
        // Get current order data to check previous status
        const orderRef = doc(db, "orders", orderId);
        const orderDoc = await getDoc(orderRef);
        
        if (!orderDoc.exists()) {
          throw new Error('Order not found');
        }
        
        const orderData = orderDoc.data();
        const previousStatus = orderData.status || 'unknown';
        
        // Create status history entry - use Date for array items, serverTimestamp for top-level fields
        const statusChange = {
          from: previousStatus,
          to: newStatus,
          changedBy: currentUser.uid,
          changedAt: new Date(), // Use Date object instead of serverTimestamp() for array items
          displayName: currentUser.displayName || currentUser.email || 'Admin User'
        };
        
        // Update order with new status and add to status history
        await updateDoc(orderRef, {
          status: newStatus,
          updatedAt: serverTimestamp(),
          statusHistory: [...(orderData.statusHistory || []), statusChange],
          ...additionalData // Include tracking number, carrier, admin notes, etc.
        });
        
        // Trigger email notification via V3 Firebase Function
        try {
          // P1-05/P2-25: no full order dumps or customer PII in browser logs —
          // ids + source are enough to trace the flow.
          console.log('🔧 Order status email:', {
            orderId,
            orderNumber: orderData.orderNumber,
            source: orderData.source
          });
          
          // Check for different user ID fields based on order type
          let actualUserId = orderData.userId;
          let userEmail = null;
          
          if (!actualUserId && orderData.b2cCustomerId) {
            console.log('🔧 DEBUG: Using B2C customer ID instead of userId');
            actualUserId = orderData.b2cCustomerId;
          }
          
          if (!actualUserId && orderData.customerInfo?.email) {
            console.log('🔧 DEBUG: Guest order detected - using email for user lookup');
            userEmail = orderData.customerInfo.email;
          }
          
          if (!actualUserId && !userEmail) {
            console.error('❌ ERROR: No user identifier found - cannot send email');
            console.error('Available fields:', Object.keys(orderData));
            throw new Error('Order must have userId, b2cCustomerId, or customerInfo.email for email notification');
          }
          
          // Get user data for email based on order type
          let userData = {
            email: 'unknown@example.com',
            companyName: 'Unknown Company',
            contactPerson: 'Unknown'
          };
          
          // New B2B Faktura orders: the buyer is in b2bCustomers (NOT users /
          // b2cCustomers), and the order already embeds the contact in
          // customerInfo — use it directly so the status-update email goes to the
          // real recipient instead of the unknown@example.com placeholder.
          if (orderData.source === 'b2b' && orderData.customerInfo?.email) {
            userData = {
              email: orderData.customerInfo.email,
              companyName: orderData.customerInfo.companyName || orderData.customerInfo.name || 'B2B Customer',
              contactPerson: orderData.customerInfo.contactPerson || orderData.customerInfo.name || 'Customer'
            };
            console.log('🔧 Using embedded B2B customerInfo for recipient');
          } else if (actualUserId) {
            console.log('🔧 DEBUG: Looking up user in "users" collection with ID:', actualUserId);
            const userDoc = await getDoc(doc(db, "users", actualUserId));
            if (userDoc.exists()) {
              userData = userDoc.data();
              console.log('🔧 Found recipient in "users"');
            } else {
              // Try B2C customers collection
              console.log('🔧 DEBUG: User not found in "users", trying "b2cCustomers" collection');
              const b2cDoc = await getDoc(doc(db, "b2cCustomers", actualUserId));
              if (b2cDoc.exists()) {
                const b2cData = b2cDoc.data();
                userData = {
                  email: b2cData.email,
                  companyName: b2cData.name || 'B2C Customer',
                  contactPerson: b2cData.name || 'Customer'
                };
                console.log('🔧 Found recipient in "b2cCustomers"');
              }
            }
          } else if (userEmail) {
            // Guest order - use email from order data
            console.log('🔧 Using guest order email as recipient');
            userData = {
              email: userEmail,
              companyName: orderData.customerInfo?.name || 'Guest Customer',
              contactPerson: orderData.customerInfo?.name || 'Guest'
            };
          }
          
          console.log('🔧 Recipient resolved');
          
          // Call NEW EmailOrchestrator order status email function
          const functions = getFunctions();
          const sendOrderStatusUpdateEmail = httpsCallable(functions, 'sendOrderStatusUpdateEmail');
          
          console.log('🔧 DEBUG: Firebase Functions initialized, preparing data...');
          
          // Ensure all string fields are properly defined to avoid Firebase serialization errors
          const safeOrderData = {
            orderNumber: String(orderData.orderNumber || `ORD-${orderId}`),
            status: String(newStatus),
            totalAmount: orderData.totalAmount || 0,
            items: orderData.items || []
          };
          
          const safeUserData = {
            email: String(userData.email || 'unknown@example.com'),
            companyName: String(userData.companyName || 'Unknown Company'),
            contactPerson: String(userData.contactPerson || userData.companyName || 'Unknown Contact')
          };
          
          const emailData = {
            orderData: safeOrderData,
            userData: safeUserData,
            newStatus: String(newStatus),
            previousStatus: String(previousStatus || 'unknown'),
            trackingNumber: additionalData.trackingNumber ? String(additionalData.trackingNumber) : null,
            estimatedDelivery: additionalData.estimatedDelivery ? String(additionalData.estimatedDelivery) : null,
            notes: additionalData.notes ? String(additionalData.notes) : null,
            // Click & Collect: name the pickup location in the ready_for_pickup email.
            pickupLocationName: orderData.pickupLocation?.name ? String(orderData.pickupLocation.name) : null,
            userId: orderData.userId,
            b2cCustomerId: orderData.b2cCustomerId,
            orderId: orderId
          };
          
          console.log('🔧 Calling sendOrderStatusUpdateEmail', { orderId, newStatus });

          const result = await sendOrderStatusUpdateEmail(emailData);

          console.log('✅ Status update emails sent:', { success: result.data?.success === true });
        } catch (emailError) {
          console.error('❌ Error sending EmailOrchestrator status update emails:', emailError);
          // Don't fail the status update if email fails
        }
        
        // ZEN Automation: Trigger customer status update on order completion (B2B
        // only) — only when the dining add-on is enabled (gate-bypass closed).
        if (isAddonEnabled('dining') && ['delivered', 'shipped', 'completed'].includes(newStatus) && orderData.userId) {
          try {
            console.log('📦 Order completed, running automation...');
            await onOrderCompleted({ 
              ...orderData, 
              ...additionalData, 
              status: newStatus,
              userId: orderData.userId,
              totalAmount: orderData.totalAmount || orderData.total
            });
          } catch (automationError) {
            console.error('❌ Error in status automation:', automationError);
          }
        } else if (['delivered', 'shipped', 'completed'].includes(newStatus)) {
          console.log('📦 Order completed (B2C/Guest order - skipping B2B automation)');
        }
        
        toast.success(`Order status updated to ${newStatus}`);
        return true;
      }
    } catch (error) {
      setError(error.message);
      toast.error('Failed to update order status: ' + error.message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [currentUser, isAdmin, demoOrders, isAddonEnabled]);

  // Get order statistics (admin only) - memoized with useCallback
  const getOrderStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      if (!isAdmin) throw new Error('Unauthorized');
      
      if (isDemoMode) {
        // Demo mode: calculate stats from mock orders
        let totalOrders = demoOrders.length;
        let newOrders = demoOrders.filter(order => order.status === 'pending').length;
        let processingOrders = demoOrders.filter(order => order.status === 'processing').length;
        let completedOrders = demoOrders.filter(order => 
          order.status === 'delivered' || order.status === 'shipped'
        ).length;
        
        return {
          totalOrders,
          newOrders,
          processingOrders,
          completedOrders
        };
      } else {
        // Real Firebase order stats (scoped to this shop)
        const ordersSnapshot = await getDocs(query(collection(db, "orders"), where("shopId", "==", shopId)));
        
        let totalOrders = 0;
        let newOrders = 0;
        let processingOrders = 0;
        let completedOrders = 0;
        
        ordersSnapshot.forEach((doc) => {
          const orderData = doc.data();
          totalOrders++;
          
          if (orderData.status === 'pending') {
            newOrders++;
          } else if (orderData.status === 'processing') {
            processingOrders++;
          } else if (orderData.status === 'delivered' || orderData.status === 'shipped') {
            completedOrders++;
          }
        });
        
        return {
          totalOrders,
          newOrders,
          processingOrders,
          completedOrders
        };
      }
    } catch (error) {
      setError(error.message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [currentUser, isAdmin, demoOrders, isDemoMode, shopId]);

  // Delete order (admin only)
  const deleteOrder = useCallback(async (orderId) => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      if (!isAdmin) throw new Error('Unauthorized');
      
      if (isDemoMode) {
        // Demo mode: mock order deletion
        setDemoOrders(orders => orders.filter(order => order.id !== orderId));
        toast.success('Order deleted successfully (Demo Mode)');
        return true;
      } else {
        // Real Firebase order deletion
        try {
          // Get the order to verify it exists
          const orderDoc = await getDoc(doc(db, "orders", orderId));
          
          if (!orderDoc.exists()) {
            throw new Error('Order not found');
          }
          
          // Delete the order
          await deleteDoc(doc(db, "orders", orderId));
          
          toast.success('Order deleted successfully');
          return true;
        } catch (error) {
          console.error('Error deleting order:', error);
          toast.error('Failed to delete order: ' + error.message);
          throw error;
        }
      }
    } catch (error) {
      setError(error.message);
      toast.error('Failed to delete order: ' + error.message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [currentUser, isAdmin, demoOrders]);

  // Cancel an order (user can cancel their own pending orders)
  const cancelOrder = useCallback(async (orderId) => {
    try {
      setLoading(true);
      setError(null);
      
      if (!currentUser) throw new Error('No authenticated user');
      
      if (isDemoMode) {
        // Demo mode: mock order cancellation
        // Get current order to validate
        const currentOrder = demoOrders.find(order => order.id === orderId);
        
        if (!currentOrder) {
          throw new Error('Order not found');
        }
        
        // Verify user owns this order or is admin
        if (currentOrder.userId !== currentUser.uid && !isAdmin) {
          throw new Error('Unauthorized');
        }
        
        // Verify order is in a cancellable state
        if (currentOrder.status !== 'pending' && currentOrder.status !== 'confirmed' && !isAdmin) {
          throw new Error('This order cannot be cancelled');
        }
        
        // Update order
        setDemoOrders(orders => 
          orders.map(order => 
            order.id === orderId 
              ? { 
                  ...order, 
                  status: 'cancelled',
                  updatedAt: new Date().toISOString(),
                  cancelledBy: currentUser.uid,
                  cancelledAt: new Date().toISOString()
                } 
              : order
          )
        );
        
        toast.success('Order cancelled successfully (Demo Mode)');
        return true;
      } else {
        // Get order to verify ownership
        const orderDoc = await getDoc(doc(db, "orders", orderId));
        
        if (!orderDoc.exists()) {
          throw new Error('Order not found');
        }
        
        const orderData = orderDoc.data();
        
        // Verify user owns this order or is admin
        if (orderData.userId !== currentUser.uid && !isAdmin) {
          throw new Error('Unauthorized');
        }
        
        // Verify order is in a cancellable state
        if (orderData.status !== 'pending' && orderData.status !== 'confirmed' && !isAdmin) {
          throw new Error('This order cannot be cancelled');
        }
        
        // Update order status to cancelled
        const updates = {
          status: 'cancelled',
          updatedAt: serverTimestamp(),
          cancelledBy: currentUser.uid,
          cancelledAt: serverTimestamp()
        };
        
        // Update in named database only
        await updateDoc(doc(db, "orders", orderId), updates);

        // Send the cancellation email via the same path as updateOrderStatus
        // (best-effort — a failed email must not fail the cancellation).
        try {
          const previousStatus = orderData.status || 'unknown';
          let userData = { email: 'unknown@example.com', companyName: 'Unknown Company', contactPerson: 'Unknown' };
          if (orderData.source === 'b2b' && orderData.customerInfo?.email) {
            userData = {
              email: orderData.customerInfo.email,
              companyName: orderData.customerInfo.companyName || orderData.customerInfo.name || 'B2B Customer',
              contactPerson: orderData.customerInfo.contactPerson || orderData.customerInfo.name || 'Customer'
            };
          } else if (orderData.userId) {
            const userDoc = await getDoc(doc(db, "users", orderData.userId));
            if (userDoc.exists()) {
              userData = userDoc.data();
            } else {
              const b2cDoc = await getDoc(doc(db, "b2cCustomers", orderData.b2cCustomerId || orderData.userId));
              if (b2cDoc.exists()) {
                const b2cData = b2cDoc.data();
                userData = { email: b2cData.email, companyName: b2cData.name || 'B2C Customer', contactPerson: b2cData.name || 'Customer' };
              }
            }
          } else if (orderData.b2cCustomerId) {
            const b2cDoc = await getDoc(doc(db, "b2cCustomers", orderData.b2cCustomerId));
            if (b2cDoc.exists()) {
              const b2cData = b2cDoc.data();
              userData = { email: b2cData.email, companyName: b2cData.name || 'B2C Customer', contactPerson: b2cData.name || 'Customer' };
            }
          } else if (orderData.customerInfo?.email) {
            userData = {
              email: orderData.customerInfo.email,
              companyName: orderData.customerInfo.name || 'Guest Customer',
              contactPerson: orderData.customerInfo.name || 'Guest'
            };
          }

          if (userData.email && userData.email !== 'unknown@example.com') {
            const functions = getFunctions();
            const sendOrderStatusUpdateEmail = httpsCallable(functions, 'sendOrderStatusUpdateEmail');
            await sendOrderStatusUpdateEmail({
              orderData: {
                orderNumber: String(orderData.orderNumber || `ORD-${orderId}`),
                status: 'cancelled',
                totalAmount: orderData.totalAmount || orderData.total || 0,
                items: orderData.items || []
              },
              userData: {
                email: String(userData.email),
                companyName: String(userData.companyName || 'Unknown Company'),
                contactPerson: String(userData.contactPerson || userData.companyName || 'Unknown Contact')
              },
              newStatus: 'cancelled',
              previousStatus: String(previousStatus),
              userId: orderData.userId,
              b2cCustomerId: orderData.b2cCustomerId,
              orderId
            });
          }
        } catch (emailError) {
          console.error('❌ Error sending cancellation email:', emailError);
          // Don't fail the cancellation if email fails
        }

        toast.success('Order cancelled successfully');
        return true;
      }
    } catch (error) {
      setError(error.message);
      toast.error('Failed to cancel order: ' + error.message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [currentUser, isAdmin, demoOrders]);

  // Update product settings (admin only)
  const updateProductSettings = useCallback(async (settings) => {
    try {
      setLoading(true);
      setError('');
      
      if (!isAdmin) {
        throw new Error('Not authorized');
      }
      
      if (isDemoMode) {
        // Demo mode: just update local settings
        Object.assign(PRODUCT_SETTINGS, settings);
        toast.success('Product settings updated (Demo Mode)');
        return true;
      } else {
        // In a real app, you would save this to Firestore
        // For now, we'll just update the local state
        Object.assign(PRODUCT_SETTINGS, settings);
        
        return true;
      }
    } catch (error) {
      console.error('Error updating product settings:', error);
      setError(error.message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);
  
  // (createDefaultProducts removed 2026-08-15 — it seeded the legacy B8 Shield
  //  fishing-product catalog and was never called from any UI. With the
  //  b8shield shop deleted it had no valid target; running it would have
  //  injected another brand's demo products into whichever shop was active.)

  const value = useMemo(() => ({
    loading,
    error,
    PRODUCT_SETTINGS,
    getOrderById,
    getUserOrders,
    getRecentOrders,
    getAllOrders,
    updateOrderStatus,
    getOrderStats,
    deleteOrder,
    cancelOrder,
    updateProductSettings,
    isDemoMode
  }), [
    loading, error, getOrderById, getUserOrders, getRecentOrders, 
    getAllOrders, updateOrderStatus, getOrderStats, deleteOrder, cancelOrder, 
    updateProductSettings
  ]);

  return (
    <OrderContext.Provider value={value}>
      {children}
    </OrderContext.Provider>
  );
};

// Create a hook to use the order context
export const useOrder = () => {
  return useContext(OrderContext);
}; 