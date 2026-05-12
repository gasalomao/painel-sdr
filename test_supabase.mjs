import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  console.log("Checking table: chats_dashboard...");
  try {
    const { data, error } = await supabase.from("chats_dashboard").select("*").limit(5);
    if (error) {
      console.error("Error reading table:", error);
    } else {
      console.log("Success! Found", data?.length || 0, "rows.");
      if (data && data.length > 0) {
        console.log("Sample Row:", JSON.stringify(data[0], null, 2));
      } else {
        console.log("The table is EMPTY. Please check n8n or Sync API.");
      }
    }
  } catch (e) {
    console.error("Unexpected error:", e);
  }
}

test();
