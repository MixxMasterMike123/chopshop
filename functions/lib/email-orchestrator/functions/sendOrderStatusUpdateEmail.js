"use strict";
// sendOrderStatusUpdateEmail - Unified Order Status Update Function  
// Replaces: sendOrderStatusEmailV3, sendOrderStatusEmail, sendStatusUpdateHttp
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOrderStatusUpdateEmail = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const database_1 = require("../../config/database");
const EmailOrchestrator_1 = require("../core/EmailOrchestrator");
const authGuard_1 = require("./authGuard");
exports.sendOrderStatusUpdateEmail = (0, https_1.onCall)({
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    try {
        const orderId = String(request.data.orderId || '').trim();
        if (!orderId)
            throw new https_1.HttpsError('invalid-argument', 'Order id is required');
        const orderSnap = await database_1.db.collection('orders').doc(orderId).get();
        if (!orderSnap.exists)
            throw new https_1.HttpsError('not-found', 'Order not found');
        const order = orderSnap.data();
        await (0, authGuard_1.requireAdminOfShop)(order.shopId, request.auth?.uid);
        // This callable is a notification side effect, not an alternate order
        // mutation API. Recipient, status and content all come from the persisted
        // tenant-scoped order; the client may only identify which order to notify.
        const storedStatus = String(order.status || '');
        if (!storedStatus || String(request.data.newStatus || '') !== storedStatus) {
            throw new https_1.HttpsError('failed-precondition', 'Order status does not match stored order');
        }
        const recipientEmail = String(order.customerInfo?.email || order.customerEmail || order.email || '').trim();
        if (!recipientEmail)
            throw new https_1.HttpsError('failed-precondition', 'Order has no customer email');
        const recipientName = String(order.customerInfo?.name ||
            [order.customerInfo?.firstName, order.customerInfo?.lastName].filter(Boolean).join(' ') ||
            order.customerName || '').trim();
        console.log('📧 sendOrderStatusUpdateEmail: Starting unified status update');
        console.log('📧 Request data:', {
            orderId,
            orderNumber: order.orderNumber,
            newStatus: storedStatus,
            previousStatus: request.data.previousStatus,
        });
        // Validate required data
        if (!order.orderNumber) {
            throw new Error('Order number is required');
        }
        // Initialize EmailOrchestrator
        const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
        // Prepare context for orchestrator
        const emailContext = {
            emailType: 'ORDER_STATUS_UPDATE',
            userId: order.userId,
            b2cCustomerId: order.b2cCustomerId,
            customerInfo: {
                email: recipientEmail,
                name: recipientName
            },
            orderId,
            language: order.customerInfo?.preferredLang || order.language,
            orderData: {
                orderNumber: String(order.orderNumber),
                status: storedStatus,
                totalAmount: Number(order.totalAmount ?? order.total ?? 0),
                items: Array.isArray(order.items) ? order.items : [],
            },
            additionalData: {
                newStatus: storedStatus,
                previousStatus: request.data.previousStatus,
                trackingNumber: order.trackingNumber || order.tracking?.number,
                estimatedDelivery: order.estimatedDelivery,
                notes: order.statusNotes || order.notes,
                pickupLocationName: order.pickupLocation?.name,
            },
            adminEmail: false
        };
        // Send email via orchestrator
        const result = await orchestrator.sendEmail(emailContext);
        if (result.success) {
            console.log('✅ sendOrderStatusUpdateEmail: Success');
            return {
                success: true,
                messageId: result.messageId,
                details: result.details
            };
        }
        else {
            console.error('❌ sendOrderStatusUpdateEmail: Failed:', result.error);
            throw new Error(result.error || 'Status update email sending failed');
        }
    }
    catch (error) {
        console.error('❌ sendOrderStatusUpdateEmail: Fatal error:', error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new Error(error instanceof Error ? error.message : 'Unknown error in status update email');
    }
});
//# sourceMappingURL=sendOrderStatusUpdateEmail.js.map