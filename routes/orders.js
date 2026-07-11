const express = require('express');
const router = express.Router();
const { generateAndUploadInvoice } = require('../invoiceService');
const supabase = require('../config/supabase'); // Consumes your centralized admin configuration client asset
const { sendInvoiceEmail } = require('../services/emailService'); // 🌟 Import your manbil email utility

/**
 * UNIVERSAL WEBHOOK / API ENDPOINT
 * Receives store checkout events to lock pricing snapshots and generate invoice system assets
 * POST /orders/shopify-webhook
 */
router.post('/shopify-webhook', async (req, res) => {
    console.log("Incoming order payload received by universal billing pipeline!");
    try {
        const orderData = req.body;

        // 1. Extract foundational cross-platform identifiers safely
        const merchant_id = orderData.merchant_id;
        
        // Dynamic order identifier mapping to support external direct checkouts or Shopify IDs
        const order_id_source = orderData.id || orderData.shopify_order_id || orderData.order_id || orderData.transaction_id;
        const shopify_order_id = order_id_source ? String(order_id_source) : null;
        
        const customer_email = orderData.email || orderData.customer_email;
        const customer_name = orderData.customer_name || 'Valued Customer';
        const product_name = orderData.product_name || 'Standard Digital Product';
        const quantity = parseInt(orderData.quantity !== undefined ? orderData.quantity : 1, 10);
        const unit_price = parseFloat(orderData.unit_price !== undefined ? orderData.unit_price : 0);
        const total_amount = parseFloat(orderData.total_price || orderData.total_amount || (quantity * unit_price));
        const currency = orderData.currency || 'USD';

        // 2. Strict Early-Return Validation for Direct Channel Inputs
        if (!merchant_id) {
            return res.status(400).json({ success: false, error: "Missing required merchant_id lookup mapping." });
        }
        if (!shopify_order_id) {
            return res.status(400).json({ success: false, error: "Missing valid transaction identifier (id, shopify_order_id, or order_id)." });
        }
        if (!customer_email) {
            return res.status(400).json({ success: false, error: "Missing customer_email parameter needed for delivery." });
        }

        // 1. DATABASE LAYER STEP: Save pricing snapshot to the orders table
        // This locks down the pricing metrics at the exact second of checkout, fixing the competitor pricing bug
        const { data: insertedOrderArray, error: orderError } = await supabase
            .from('orders')
            .insert([{
                merchant_id: merchant_id,
                shopify_order_id: shopify_order_id,
                customer_email: customer_email,
                customer_name: customer_name,
                product_name: product_name,
                quantity: quantity,
                unit_price: unit_price,
                total_amount: total_amount,
                currency: currency
            }])
            .select();

       if (orderError) {
            throw new Error(`Database Order Snapshot insertion failed: ${orderError.message}`);
        }
        
        // ADD THIS CHECK IMMEDIATELY BEFORE ACCESSING THE ZERO INDEX ELEMENT:
        if (!insertedOrderArray || insertedOrderArray.length === 0) {
            throw new Error("Database transaction failed: No order records were returned from Supabase client layer.");
        }
        
        const savedOrder = insertedOrderArray[0];

        // 2. FILE STORAGE LAYER STEP: Generate headless PDF asset safely via Puppeteer engine
        const publicUrl = await generateAndUploadInvoice(savedOrder);

        // 3. INVOICE INDEX TRACKING STEP: Log generated asset references to the invoices tracking table
        // Generate a dynamic platform-neutral sequential invoice identifier number
        const uniqueInvoiceSuffix = savedOrder.shopify_order_id && savedOrder.shopify_order_id !== 'undefined'
            ? savedOrder.shopify_order_id
            : `${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

        const { error: invoiceError } = await supabase
            .from('invoices')
            .insert([{
                merchant_id: savedOrder.merchant_id,
                order_id: savedOrder.id,
                invoice_number: `INV-${uniqueInvoiceSuffix}`,
                pdf_url: publicUrl,
                status: 'generated'
            }]);

        if (invoiceError) {
            throw new Error(`Invoice index logging failed: ${invoiceError.message}`);
        }

        // 4. EMAIL TRANSMISSION STEP: Programmatically email the invoice PDF link to the customer
        // This sends a cleanly styled, manbil-branded template via Resend for $0.00
        const emailDelivery = await sendInvoiceEmail(customer_email, customer_name, publicUrl);
        if (!emailDelivery.success) {
            console.error(`Non-blocking Alert: Invoice email delivery failed:`, emailDelivery.error);
        }

        // Return successful processing status metrics
        return res.status(200).json({
            success: true,
            message: "Order billing elements locked and invoice system assets generated!",
            order_id: savedOrder.id,
            invoice_url: publicUrl
        });

    } catch (err) {
        console.error('Critical transactional webhook processing failure:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;