const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const path = require("path");
// Consume your centralized admin supabase client configuration asset directly
const supabase = require("./config/supabase");

/**
 * Checks a merchant's subscription quota and increments usage safely.
 * Rejects invoice creation if monthly limits are reached.
 */
async function checkAndIncrementUsage(merchant_id) {
  const { data: merchant, error } = await supabase
    .from("merchant")
    .select("invoice_count, invoice_limit")
    .eq("id", merchant_id)
    .single();

  if (error || !merchant) {
    console.error(
      "Quota Check Failed:",
      error ? error.message : "No merchant record found for ID " + merchant_id,
    );
    throw new Error("Merchant account data records not found");
  }

  // Enforce tier limit (default to 500 if limit not defined)
  const limit = merchant.invoice_limit || 500;
  if ((merchant.invoice_count || 0) >= limit) {
    throw new Error(
      "Monthly invoice limit reached. Please upgrade your plan to continue generating invoices.",
    );
  }

  const { error: updateError } = await supabase
    .from("merchant")
    .update({ invoice_count: (merchant.invoice_count || 0) + 1 })
    .eq("id", merchant_id);

  if (updateError) {
    throw new Error(
      "Failed to update merchant usage counter analytics: " +
        updateError.message,
    );
  }

  return true;
}

/**
 * Generates an invoice PDF using headless Chrome and uploads it to storage
 */
async function generateAndUploadInvoice(orderData) {
  // Check quota before launching browser process
  await checkAndIncrementUsage(orderData.merchant_id);

  const launchOptions = {
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  // Use local executable if explicitly defined locally on Windows
  if (
    process.env.CHROME_PATH &&
    process.env.CHROME_PATH.includes("C:\\") &&
    process.env.NODE_ENV !== "production"
  ) {
    launchOptions.executablePath = process.env.CHROME_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  // Correct path pointing inside the templates directory
  const templatePath = path.join(
    __dirname,
    "templates",
    "invoice-template.html",
  );
  let html = await fs.readFile(templatePath, "utf8");

  // Replace layout placeholders with true order metrics matching your invoice-template.html
  html = html
    .replace("{{order_id}}", orderData.shopify_order_id || "")
    .replace("{{customer_name}}", orderData.customer_name || "")
    .replace("{{product_name}}", orderData.product_name || "")
    .replace("{{quantity}}", orderData.quantity || "")
    .replace("{{unit_price}}", orderData.unit_price || "")
    .replace(
      "{{total_price}}",
      orderData.quantity && orderData.unit_price
        ? (orderData.quantity * orderData.unit_price).toFixed(2)
        : "0.00",
    )
    .replace("{{generated_at}}", new Date().toLocaleDateString());

  await page.setContent(html);
  const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();

  const filename = `invoices/${orderData.shopify_order_id || orderData.id}.pdf`;
  const { error } = await supabase.storage
    .from("invoices")
    .upload(filename, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (error) throw error;

  const {
    data: { publicUrl },
  } = supabase.storage.from("invoices").getPublicUrl(filename);
  return publicUrl;
}

module.exports = { generateAndUploadInvoice, checkAndIncrementUsage };
