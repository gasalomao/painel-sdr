import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(supabaseUrl, supabaseKey!)

async function checkRLS() {
  const { data, error } = await supabase.rpc('check_rls', {})
  // Since we don't have a check_rls function, we can query pg_tables or pg_class if we have raw access
  // Let's just run an update to disable RLS just in case.
}
checkRLS()
