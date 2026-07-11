// Dummy data to simulate an incoming store checkout webhook
const testPayload = {
  merchant_id: "eff491c1-56dd-4c6d-af50-81bf0b0f3062", 
  customer_name: "Alice Smith",
  customer_email: "alice@example.com",
  product_name: "Automated Invoice Dashboard",
  quantity: 1,
  unit_price: 49.99,
  total_price: 49.99,
  currency: "USD",
   shopify_order_id: "ORDER12345"
};

console.log("Sending test checkout payload to local server...");

// Fire a POST request to our newly mounted route
fetch('http://localhost:5000/orders/shopify-webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(testPayload)
})
.then(res => res.json())
.then(data => {
  console.log('\n--- TEST SUCCESSFUL ---');
  console.log('Response from server:', data);
})
.catch(err => {
  console.error('\n--- TEST FAILED ---');
  console.error('Error pinging server:', err.message);
});