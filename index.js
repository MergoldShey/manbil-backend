const express = require('express');
const cookieParser = require('cookie-parser'); // Added to parse security tracking state cookies
const supabase = require('./config/supabase');
require('dotenv').config();

// 1. Import routing layers
const ordersRouter = require('./routes/orders');
const shopifyAuthRouter = require('./routes/shopifyAuth'); // Imported Step 1 auth router

const app = express();
const PORT = process.env.PORT || 8000;

// Essential Middleware Layers
app.use(express.json());
app.use(cookieParser()); // Required to safely read authentication cookies from Shopify installations

// 2. Mount routing layers under explicit URL endpoint prefixes
app.use('/api', ordersRouter);
app.use('/orders', ordersRouter);
app.use('/auth', shopifyAuthRouter); // Mounted Shopify installation routes safely to the root path

// A live database connection test endpoint
app.get('/test-db', async (req, res) => {
    try {
        // FIX: Table point query uses 'merchant' to fully align with schema constraints
        const { data, error } = await supabase.from('merchant').select('id').limit(1);

        if (error) throw error;

        res.json({
            success: true,
            message: "Manbil engine successfully connected to invoice-manager-db cloud database!",
            data
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: "Database connection failed.",
            error: err.message
        });
    }
});

app.get('/', (req, res) => {
    res.send('Manbil Backend API engine is running successfully!');
});

app.listen(PORT, () => {
    console.log(`Manbil server is officially running on port ${PORT}`);
});