import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!supabaseServiceKey) {
  console.warn("⚠️ ALERTA: SUPABASE_SERVICE_ROLE_KEY não encontrada no .env.local. Usando chave comum (pode dar erro de permissão).");
}

export const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceKey || (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''),
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)
