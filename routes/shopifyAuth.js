const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const supabase = require('../config/supabase'); // Uses your centralized admin client

// 1. READ ENVIRONMENT VARIABLES
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_SCOPE = 'read_orders,read_products'; // Access levels needed to track checkouts
const REDIRECT_URI = process.env.HOST + '/auth/shopify/callback'; 

/**
 * START THE OAUTH FLOW
 * GET /auth/shopify?shop=store-name.myshopify.com
 */
router.get('/shopify', (req, res) => {
    const shop = req.query.shop;

    if (!shop) {
        return res.status(400).send('Missing shop parameter. Cannot initialize connection.');
    }

    // Escape character checks to validate the shop domain name format
    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!shopRegex.test(shop)) {
        return res.status(400).send('Invalid Shopify store URL provided.');
    }

    // Generate a secure random state token to prevent Cross-Site Request Forgery (CSRF)
    const state = crypto.randomBytes(16).toString('hex');

    // Build Shopify install redirect target URL
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${APP_SCOPE}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

    // Set temporary state cookie tracking values
    res.cookie('shopifyState', state, { httpOnly: true, secure: true, sameSite: 'none' });

    // Redirect the merchant to Shopify's app permission screen
    return res.redirect(installUrl);
});

/**
 * COMPLETE OAUTH HANDSHAKE
 * GET /auth/shopify/callback
 */
router.get('/shopify/callback', async (req, res) => {
    const { shop, hmac, code, state } = req.query;
    const stateCookie = req.cookies.shopifyState;

    // A. Validate the state parameter to match tracking strings
    if (!state || state !== stateCookie) {
        return res.status(403).send('Security validation failed: Request origin could not be verified.');
    }

    // B. Verify the HMAC signature to prove this call comes authentically from Shopify
    const map = Object.assign({}, req.query);
    delete map['hmac'];
    const message = Object.keys(map).sort().map(key => `${key}=${map[key]}`).join('&');
    const providedHmac = Buffer.from(hmac || '', 'utf-8');
    const generatedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
    const compiledHmac = Buffer.from(generatedHmac, 'utf-8');

    if (providedHmac.length !== compiledHmac.length || !crypto.timingSafeEqual(providedHmac, compiledHmac)) {
        return res.status(400).send('HMAC signature verification failed. Unauthorized request context.');
    }

    try {
        // C. Exchange the temporary code for a permanent Access Token
        const accessTokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
        const accessTokenPayload = {
            client_id: SHOPIFY_API_KEY,
            client_secret: SHOPIFY_API_SECRET,
            code
        };

        const response = await fetch(accessTokenRequestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(accessTokenPayload)
        });

        const tokenData = await response.json();
        const accessToken = tokenData.access_token;

        if (!accessToken) {
            throw new Error('Did not receive a valid access token asset back from Shopify.');
        }

        // D. INSERT OR UPDATE MERCHANT IN YOUR SUPABASE 'merchant' TABLE
        // This links the Shopify profile securely into your existing database layer blueprint.
        const { data, error } = await supabase
            .from('merchant')
            .upsert({
                id: shop, // Using the unique myshopify domain as the record identifier
                store_name: shop.replace('.myshopify.com', ''),
                subscription_plan: 'free', // Default tier schema assigned automatically on installation
                invoice_count: 0,
                invoice_limit: 50 // Baseline starter quota
            }, { onConflict: 'id' })
            .select();

        if (error) {
            throw new Error(`Failed to sync Shopify account profile metadata to database: ${error.message}`);
        }

        // Clear tracking verification cookies safely
        res.clearCookie('shopifyState');

        // E. REDIRECT MERCHANT DIRECTLY TO FRONTEND NEXT.JS DASHBOARD
        // This routes them straight into your application layout ecosystem
        return res.redirect(`${process.env.FRONTEND_URL}/dashboard?shop=${shop}`);

    } catch (err) {
        console.error('Critical authorization flow runtime failure:', err.message);
        return res.status(500).send('An unexpected structural error occurred during the installation flow.');
    }
});

module.exports = router;