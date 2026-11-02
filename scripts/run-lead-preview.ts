import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseServiceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Variáveis do Supabase ausentes.");
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, supabaseServiceKey);

  console.log("Obtendo dados do Lead #1968 (Espaço Florescer Nail designer by Dani)...");
  const { data: lead, error } = await sb
    .from("leads_extraidos")
    .select("*")
    .eq("id", 1968)
    .single();

  if (error || !lead) {
    console.error("Erro ao buscar lead 1968:", error);
    process.exit(1);
  }

  console.log(`Lead carregado: #${lead.id} - ${lead.nome_negocio} (${lead.ramo_negocio}, ${lead.reviews} avaliações, nota ${lead.avaliacao})`);
  console.log("Disparando processSingleLeadPreview...");

  const { processSingleLeadPreview } = await import("../src/lib/sites/autonomous-worker-engine");
  const success = await processSingleLeadPreview(lead);
  console.log(`Resultado do processamento: ${success ? "SUCESSO" : "FALHA"}`);

  // Consulta status final do lead no Supabase
  const { data: updatedLead } = await sb
    .from("leads_extraidos")
    .select("id, nome_negocio, previa_status, previa_url, previa_qa_score, previa_error")
    .eq("id", 1968)
    .single();

  console.log("Status final do lead no banco:", updatedLead);
}

main().catch((err) => {
  console.error("Erro na execução:", err);
  process.exit(1);
});
