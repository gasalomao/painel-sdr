const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
    const { data: cols, error: err1 } = await supabase.rpc('get_columns'); 
    // or just fetch 1 row
    const { data, error } = await supabase.from('leads_extraidos').select('*').limit(5);
    console.log("Error:", error);
    console.log("Data keys:", data && data.length > 0 ? Object.keys(data[0]) : "no data");
    console.log("Data:", data);
}

check();
