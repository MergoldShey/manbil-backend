const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");

/**
 * CREATE SHOPIFY RECURRING SUBSCRIPTION CHARGE
 * POST /billing/create-subscription
 */
router.post("/create-subscription", async (req, res) => {
  const { shop, planName, price } = req.body;

  if (!shop) {
    return res
      .status(400)
      .json({ success: false, error: "Missing shop parameter." });
  }

  try {
    // 1. Fetch merchant's access token from Supabase
    const { data: merchant, error } = await supabase
      .from("merchant")
      .select("access_token")
      .eq("shop_domain", shop)
      .single();

    if (error || !merchant?.access_token) {
      return res
        .status(404)
        .json({ success: false, error: "Merchant access token not found." });
    }

    const host = process.env.HOST;
    const returnUrl = `${host}/billing/callback?shop=${shop}`;

    // 2. GraphQL Mutation for Shopify AppSubscriptionCreate
    const graphqlQuery = {
      query: `
        mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
          appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, test: $test) {
            userErrors {
              field
              message
            }
            confirmationUrl
            appSubscription {
              id
            }
          }
        }
      `,
      variables: {
        name: planName || "Pro Plan",
        returnUrl: returnUrl,
        test: process.env.NODE_ENV !== "production", // Enable test charges in development
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: price || 9.99, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    };

    // 3. Request confirmation URL from Shopify Admin API
    const response = await fetch(
      `https://${shop}/admin/api/2024-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": merchant.access_token,
        },
        body: JSON.stringify(graphqlQuery),
      },
    );

    const result = await response.json();
    const subscriptionData = result.data?.appSubscriptionCreate;

    if (subscriptionData?.userErrors?.length > 0) {
      return res.status(400).json({
        success: false,
        errors: subscriptionData.userErrors,
      });
    }

    // Return the confirmation URL to redirect the merchant
    return res.status(200).json({
      success: true,
      confirmationUrl: subscriptionData.confirmationUrl,
    });
  } catch (err) {
    console.error("Shopify Billing Error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * HANDLE BILLING CALLBACK & ACTIVATE SUBSCRIPTION
 * GET /billing/callback
 */
router.get("/callback", async (req, res) => {
  const { shop, charge_id } = req.query;

  if (!shop || !charge_id) {
    return res.status(400).send("Missing shop or charge_id parameters.");
  }

  try {
    // 1. Fetch merchant's access token from Supabase
    const { data: merchant, error } = await supabase
      .from("merchant")
      .select("id, access_token")
      .eq("shop_domain", shop)
      .single();

    if (error || !merchant?.access_token) {
      return res.status(404).send("Merchant record not found.");
    }

    // 2. Query Shopify to verify the charge status
    const response = await fetch(
      `https://${shop}/admin/api/2024-04/recurring_application_charges/${charge_id}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": merchant.access_token,
        },
      },
    );

    const chargeData = await response.json();
    const charge = chargeData.recurring_application_charge;

    if (charge && charge.status === "active") {
      // 3. Upgrade merchant in Supabase (Increase invoice limit to 1000 for Pro plan)
      const { error: updateError } = await supabase
        .from("merchant")
        .update({
          subscription_plan: "pro",
          invoice_limit: 1000,
          updated_at: new Date().toISOString(),
        })
        .eq("id", merchant.id);

      if (updateError) {
        throw new Error(
          `Failed to update subscription in database: ${updateError.message}`,
        );
      }

      // 4. Redirect merchant back to your frontend dashboard
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard?shop=${shop}&billing=success`,
      );
    }

    return res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?shop=${shop}&billing=failed`,
    );
  } catch (err) {
    console.error("Billing Callback Processing Error:", err.message);
    return res.status(500).send("Error processing billing activation.");
  }
});

module.exports = router;
