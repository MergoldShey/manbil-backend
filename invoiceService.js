const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;
const path = require('path');
// Consume your centralized admin supabase client configuration asset directly
const supabase = require('./config/supabase'); 

/**
 * Checks a merchant's current tier limits and increments usage safely
 */
async function checkAndIncrementUsage(merchant_id) {
    // FIXED: Changed table pointer from plural 'merchants' to singular lowercase 'merchant' to match your frontend model parameters
    const { data: merchant, error } = await supabase
        .from('merchant')
        .select('invoice_count')
        .eq('id', merchant_id)
        .single();

    if (error || !merchant) throw new Error("Merchant account data records not found");

    const { error: updateError } = await supabase
        .from('merchant')
        .update({ invoice_count: (merchant.invoice_count || 0) + 1 })
        .eq('id', merchant_id);

    if (updateError) throw new Error("Failed to update merchant usage counter analytics");
    return true;
}

/**
 * Generates an invoice PDF using headless Chrome and uploads it to storage
 */
async function generateAndUploadInvoice(orderData) {
    await checkAndIncrementUsage(orderData.merchant_id);

   // REPLACED THE OLD LAUNCH ENGINE ARGS BLOCK:
// const browser = await puppeteer.launch({
//     executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
//     args: ['--no-sandbox', '--disable-setuid-sandbox']
// });

// WITH THIS SECURE COMPATIBILITY BLOCK:
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Prevents container crashes on low-spec host nodes
        '--disable-gpu'            // Prevents checking for graphics drivers on server hosts
    ]
});
    const page = await browser.newPage();

    // REPLACED THE OLD LINE:
// let html = await fs.readFile('./templates/invoice-template.html', 'utf8');

// WITH THIS NEW LINE:
let html = await fs.readFile(path.join(__dirname, 'invoice-template.html'), 'utf8');
    
    // Replace layout placeholders with true order metrics
    html = html.replace('{{order_id}}', orderData.shopify_order_id)
        .replace('{{customer_name}}', orderData.customer_name)
        .replace('{{product_name}}', orderData.product_name)
        .replace('{{quantity}}', orderData.quantity)
        .replace('{{unit_price}}', orderData.unit_price)
        .replace('{{total_price}}', (orderData.quantity * orderData.unit_price).toFixed(2))
        .replace('{{generated_at}}', new Date().toLocaleDateString());

    await page.setContent(html);
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    const filename = `invoices/${orderData.shopify_order_id || orderData.id}.pdf`;
    const { error } = await supabase.storage
        .from('invoices')
        .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage.from('invoices').getPublicUrl(filename);
    return publicUrl;
}

module.exports = { generateAndUploadInvoice };