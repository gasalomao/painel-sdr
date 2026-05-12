import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  console.log("Checking leads_extraidos...");
  const { count: leadsCount, error: leadsError } = await supabase
    .from("leads_extraidos")
    .select("*", { count: "exact", head: true });
  
  if (leadsError) {
    console.error("Error checking leads:", leadsError);
  } else {
    console.log("Total leads in DB:", leadsCount);
  }

  console.log("Checking chats_dashboard...");
  const { count: chatsCount, error: chatsError } = await supabase
    .from("chats_dashboard")
    .select("*", { count: "exact", head: true });
  
  if (chatsError) {
    console.error("Error checking chats:", chatsError);
  } else {
    console.log("Total chats in DB:", chatsCount);
  }

  if (leadsCount > 0) {
    const { data } = await supabase.from("leads_extraidos").select("*").limit(1);
    console.log("Sample Lead:", JSON.stringify(data[0], null, 2));
  }
}

check();
