const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const supabase = require("../config/supabase");

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_SCOPE = "read_orders,read_products";
const REDIRECT_URI = process.env.HOST + "/auth/shopify/callback";

/**
 * START THE OAUTH FLOW
 * GET /auth/shopify?shop=store-name.myshopify.com
 */
router.get("/shopify", (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res
      .status(400)
      .send("Missing shop parameter. Cannot initialize connection.");
  }

  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
  if (!shopRegex.test(shop)) {
    return res.status(400).send("Invalid Shopify store URL provided.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${APP_SCOPE}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

  res.cookie("shopifyState", state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });

  return res.redirect(installUrl);
});

/**
 * COMPLETE OAUTH HANDSHAKE
 * GET /auth/shopify/callback
 */
router.get("/shopify/callback", async (req, res) => {
  const { shop, hmac, code, state, host } = req.query;
  const stateCookie = req.cookies.shopifyState;

  if (!state || state !== stateCookie) {
    return res
      .status(403)
      .send(
        "Security validation failed: Request origin could not be verified.",
      );
  }

  const map = Object.assign({}, req.query);
  delete map["hmac"];
  const message = Object.keys(map)
    .sort()
    .map((key) => `${key}=${map[key]}`)
    .join("&");

  const providedHmac = Buffer.from(hmac || "", "utf-8");
  const generatedHmac = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  const compiledHmac = Buffer.from(generatedHmac, "utf-8");

  if (
    providedHmac.length !== compiledHmac.length ||
    !crypto.timingSafeEqual(providedHmac, compiledHmac)
  ) {
    return res
      .status(400)
      .send(
        "HMAC signature verification failed. Unauthorized request context.",
      );
  }

  try {
    const accessTokenRequestUrl = `https://${shop}/admin/oauth/access_token`;
    const accessTokenPayload = {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    };

    const response = await fetch(accessTokenRequestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(accessTokenPayload),
    });

    const tokenData = await response.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error(
        "Did not receive a valid access token asset back from Shopify.",
      );
    }

    // Check if merchant already exists
    const { data: existingMerchant } = await supabase
      .from("merchant")
      .select("id")
      .eq("shop_domain", shop)
      .single();

    let dbError;

    if (existingMerchant) {
      // Update existing record
      const { error } = await supabase
        .from("merchant")
        .update({ access_token: accessToken })
        .eq("shop_domain", shop);
      dbError = error;
    } else {
      // Insert new record with explicit UUID
      const { error } = await supabase.from("merchant").insert([
        {
          id: crypto.randomUUID(),
          shop_domain: shop,
          access_token: accessToken,
          store_name: shop.replace(".myshopify.com", ""),
          subscription_plan: "free",
          invoice_count: 0,
          invoice_limit: 50,
        },
      ]);
      dbError = error;
    }

    if (dbError) {
      throw new Error(
        `Failed to sync Shopify account profile metadata to database: ${dbError.message}`,
      );
    }

    res.clearCookie("shopifyState");

    // Safe host parameter encoding & embedded Shopify Admin redirect path
    const hostQuery = host ? `?host=${encodeURIComponent(host)}` : "";
    const shopifyAdminAppUrl = `https://${shop}/admin/apps/${SHOPIFY_API_KEY}${hostQuery}`;

    return res.redirect(shopifyAdminAppUrl);
  } catch (err) {
    console.error("Critical authorization flow runtime failure:", err.message);
    return res
      .status(500)
      .send(
        "An unexpected structural error occurred during the installation flow.",
      );
  }
});

module.exports = router;
