const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
// We are now using the service role key for backend admin privileges
const supabaseServiceKey = process.env.SUPABASE_KEY; 

const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = supabase;