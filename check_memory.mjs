import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl!, supabaseKey!);

async function checkMemoryStructure() {
  console.log("Checking structure of n8n_chat_histories...");
  const { data, error } = await supabase.from("n8n_chat_histories").select("*").limit(3);
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Rows found:", data.length);
    console.log("Sample Memory JSON:", JSON.stringify(data[0]?.message, null, 2));
    console.log("Sample Columns:", Object.keys(data[0] || {}));
  }
}

checkMemoryStructure();
