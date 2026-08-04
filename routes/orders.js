const express = require("express");
const router = express.Router();
const { generateAndUploadInvoice } = require("../invoiceService");
const supabase = require("../config/supabase");
const { sendInvoiceEmail } = require("../services/emailService");

/**
 * UNIVERSAL WEBHOOK / API ENDPOINT
 * Receives store checkout events to lock pricing snapshots and generate invoice system assets
 * POST /orders/shopify-webhook
 */
router.post("/shopify-webhook", async (req, res) => {
  console.log("Incoming order payload received by universal billing pipeline!");
  try {
    const orderData = req.body;

    // 1. DYNAMIC MERCHANT LOOKUP & USAGE VERIFICATION
    const rawDomain =
      req.headers["x-shopify-shop-domain"] ||
      orderData.domain ||
      orderData.shop ||
      "manbil-test-store.myshopify.com";

    const shopDomain = rawDomain ? rawDomain.toLowerCase().trim() : null;
    let merchantRecord = null;

    if (shopDomain) {
      const { data, error: merchantError } = await supabase
        .from("merchant")
        .select("id, invoice_count, invoice_limit, subscription_plan")
        .eq("shop_domain", shopDomain)
        .maybeSingle();

      if (merchantError) {
        console.error("Supabase merchant lookup error:", merchantError.message);
      }
      merchantRecord = data;
    }

    if (!merchantRecord) {
      console.error(`Merchant account lookup failed for domain: ${shopDomain}`);
      return res.status(400).json({
        success: false,
        error: `Merchant account data record not found for domain: ${shopDomain}`,
      });
    }

    const merchant_id = merchantRecord.id;
    const currentCount = merchantRecord.invoice_count || 0;
    const limit = merchantRecord.invoice_limit || 50;

    // 2. TRIAL & USAGE LIMIT GATEKEEPER
    if (currentCount >= limit) {
      console.warn(
        `Trial/Usage limit reached for merchant ${shopDomain}. Action blocked.`,
      );
      return res.status(402).json({
        success: false,
        limit_reached: true,
        error:
          "Invoice usage limit reached. Please upgrade your subscription plan to continue generating invoices.",
        upgrade_url: `/dashboard/billing?shop=${shopDomain}`,
      });
    }

    // 3. EXTRACT ORDER IDENTIFIERS & CUSTOMER DETAILS SAFELY
    const order_id_source =
      orderData.id ||
      orderData.shopify_order_id ||
      orderData.order_id ||
      orderData.transaction_id;
    const shopify_order_id = order_id_source ? String(order_id_source) : null;

    const customer_email =
      orderData.email || orderData.customer_email || orderData.customer?.email;

    let customer_name = orderData.customer_name;
    if (!customer_name && orderData.customer) {
      customer_name =
        `${orderData.customer.first_name || ""} ${orderData.customer.last_name || ""}`.trim();
    }
    if (!customer_name) customer_name = "Valued Customer";

    // 4. EXTRACT PRODUCT & LINE ITEM DETAILS SAFELY
    const firstLineItem =
      orderData.line_items && orderData.line_items.length > 0
        ? orderData.line_items[0]
        : {};

    const product_name =
      orderData.product_name ||
      firstLineItem.title ||
      "Standard Digital Product";
    const quantity = parseInt(
      orderData.quantity !== undefined
        ? orderData.quantity
        : firstLineItem.quantity || 1,
      10,
    );
    const unit_price = parseFloat(
      orderData.unit_price !== undefined
        ? orderData.unit_price
        : firstLineItem.price || 0,
    );
    const total_amount = parseFloat(
      orderData.total_price || orderData.total_amount || quantity * unit_price,
    );
    const currency = orderData.currency || "USD";

    if (!shopify_order_id) {
      return res.status(400).json({
        success: false,
        error:
          "Missing valid transaction identifier (id, shopify_order_id, or order_id).",
      });
    }
    if (!customer_email) {
      return res.status(400).json({
        success: false,
        error: "Missing customer_email parameter needed for delivery.",
      });
    }

    // 5. DATABASE LAYER: Save locked pricing snapshot to 'orders' table
    const { data: insertedOrderArray, error: orderError } = await supabase
      .from("orders")
      .insert([
        {
          merchant_id: merchant_id,
          shopify_order_id: shopify_order_id,
          customer_email: customer_email,
          customer_name: customer_name,
          product_name: product_name,
          quantity: quantity,
          unit_price: unit_price,
          total_amount: total_amount,
          currency: currency,
        },
      ])
      .select();

    if (orderError) {
      throw new Error(
        `Database Order Snapshot insertion failed: ${orderError.message}`,
      );
    }

    const savedOrder = insertedOrderArray[0];

    // 6. FILE STORAGE LAYER: Generate PDF asset via Puppeteer engine
    const publicUrl = await generateAndUploadInvoice(savedOrder);

    // 7. INVOICE INDEX TRACKING LAYER: Save metadata reference
    const uniqueInvoiceSuffix =
      savedOrder.shopify_order_id && savedOrder.shopify_order_id !== "undefined"
        ? savedOrder.shopify_order_id
        : `${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const { error: invoiceError } = await supabase.from("invoices").insert([
      {
        merchant_id: savedOrder.merchant_id,
        order_id: savedOrder.id,
        invoice_number: `INV-${uniqueInvoiceSuffix}`,
        pdf_url: publicUrl,
        status: "generated",
      },
    ]);

    if (invoiceError) {
      throw new Error(`Invoice index logging failed: ${invoiceError.message}`);
    }

    // 8. INCREMENT USAGE COUNTER IN DATABASE
    await supabase
      .from("merchant")
      .update({ invoice_count: currentCount + 1 })
      .eq("id", merchant_id);

    // 9. EMAIL TRANSMISSION LAYER: Send invoice PDF link via Resend
    const emailDelivery = await sendInvoiceEmail(
      customer_email,
      customer_name,
      publicUrl,
    );
    if (!emailDelivery.success) {
      console.error(
        `Non-blocking Alert: Invoice email delivery failed:`,
        emailDelivery.error,
      );
    }

    return res.status(200).json({
      success: true,
      message:
        "Order billing elements locked and invoice system assets generated!",
      order_id: savedOrder.id,
      invoice_url: publicUrl,
    });
  } catch (err) {
    console.error(
      "Critical transactional webhook processing failure:",
      err.message,
    );
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
