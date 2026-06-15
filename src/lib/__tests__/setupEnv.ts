import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
console.log("Env variables loaded successfully. NEXT_PUBLIC_SUPABASE_URL is defined:", !!process.env.NEXT_PUBLIC_SUPABASE_URL);
