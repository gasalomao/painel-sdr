import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

let _supabase: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const isValidUrl = supabaseUrl && (supabaseUrl.startsWith('http://') || supabaseUrl.startsWith('https://'));
    
    if (!isValidUrl || supabaseUrl === 'url_aqui') {
      console.warn("Supabase: URL inválida ou placeholder detectado. Usando Mock Robusto.");
      // Proxy-based mock to handle any chained method (select, order, range, eq, etc.)
      const handler = {
        get(target: any, prop: string): any {
          if (prop === 'then') {
            return (resolve: any) => resolve({ data: [], count: 0, error: null });
          }
          return (...args: any[]) => {
            // Chaining: return the proxy again
            return new Proxy({}, handler);
          };
        }
      };
      _supabase = new Proxy({}, handler) as unknown as SupabaseClient;
    } else {
      _supabase = createClient(supabaseUrl, supabaseAnonKey);
    }
  }
  return _supabase;
}

const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// Initialize admin client only if key is present (server-side)
export const supabaseAdmin = supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop: string) {
    const client = getSupabase()
    const value = (client as unknown as Record<string, unknown>)[prop]
    if (typeof value === 'function') {
      return value.bind(client)
    }
    return value
  },
})
