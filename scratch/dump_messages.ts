
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function dumpMessages() {
  const { data, error } = await supabase
    .from('chats_dashboard')
    .select('id, remote_jid, sender_type, content, created_at, message_id')
    .order('id', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error:', error);
    return;
  }
  
  console.table(data);
}

dumpMessages();
