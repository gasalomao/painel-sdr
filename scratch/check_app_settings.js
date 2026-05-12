// Script para criar a tabela app_settings no Supabase
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log("Verificando tabela app_settings...");

  // Tenta inserir um registro para verificar se a tabela existe
  const { data, error } = await supabase
    .from("app_settings")
    .select("key")
    .eq("key", "public_url")
    .single();

  if (error && error.code === "PGRST116") {
    // Tabela existe mas nenhum registro encontrado - inserir padrão
    console.log("Tabela existe. Inserindo registro padrão...");
    const { error: insertErr } = await supabase
      .from("app_settings")
      .insert({ key: "public_url", value: "", updated_at: new Date().toISOString() });
    
    if (insertErr) {
      console.log("Erro ao inserir:", insertErr.message);
    } else {
      console.log("✅ Registro padrão inserido!");
    }
  } else if (error && error.message.includes("does not exist")) {
    console.log("❌ Tabela app_settings NÃO existe!");
    console.log("Crie a tabela no Supabase SQL Editor com:");
    console.log(`
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_settings (key, value)
VALUES ('public_url', '');
    `);
  } else if (data) {
    console.log("✅ Tabela existe e registro encontrado:", data);
  } else {
    console.log("Resultado:", { data, error });
  }
}

main().catch(console.error);
