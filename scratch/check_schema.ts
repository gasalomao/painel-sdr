
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function checkSchema() {
  const { data, error } = await supabase
    .from('chats_dashboard')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error:', error);
    return;
  }
  
  if (data && data.length > 0) {
    console.log('Columns:', Object.keys(data[0]));
    console.log('Sample Row:', data[0]);
  } else {
    console.log('No data found in chats_dashboard');
  }
}

checkSchema();
