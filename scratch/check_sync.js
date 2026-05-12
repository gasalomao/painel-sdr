// Check the public_url in app_settings and the last webhook logs
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log("--- APP SETTINGS ---");
  const { data: setting } = await supabase.from("app_settings").select("*");
  console.log(setting);

  console.log("\n--- LAST WEBHOOK LOGS ---");
  const { data: logs } = await supabase.from("webhook_logs").select("*").order("created_at", { ascending: false }).limit(5);
  console.log(logs);

  console.log("\n--- LAST MESSAGES ---");
  const { data: msgs } = await supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(3);
  console.log(msgs);
}

main().catch(console.error);
