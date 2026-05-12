import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  console.log("Checking campaign_logs...");
  const { data, count, error } = await supabase
    .from("campaign_logs")
    .select("*", { count: "exact" });
  
  if (error) {
    console.error("Error checking logs:", error);
  } else {
    console.log("Total logs in DB:", count);
    if (data && data.length > 0) {
      console.log("Sample Log:", JSON.stringify(data[0], null, 2));
    }
  }

  console.log("Checking campaigns...");
  const { data: campaigns } = await supabase.from("campaigns").select("id, name, status");
  console.log("Campaigns:", campaigns);
}

check();
