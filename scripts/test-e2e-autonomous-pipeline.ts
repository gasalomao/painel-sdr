import { config } from "dotenv";
config({ path: ".env.local" });
config();

// Salvaguarda: em teste, pula o envio do WhatsApp real para o cliente
process.env.SKIP_PREVIEW_PING = "true";

async function main() {
  console.log("\n===========================================================");
  console.log("🧪 TESTE END-TO-END: AUTOMAÇÃO DE PROSPECÇÃO DE SITES IA");
  console.log("===========================================================\n");

  const supabaseAdminModule = await import("../src/lib/supabase_admin");
  const supabaseAdmin = supabaseAdminModule.supabaseAdmin || (supabaseAdminModule as any).default?.supabaseAdmin;
  const { processSingleLeadPreview } = await import("../src/lib/sites/autonomous-worker-engine");

  if (!supabaseAdmin) {
    throw new Error("Supabase indisponível. Verifique NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  }

  // Permite passar o ID do lead como argumento (ex: npx tsx scripts/test-e2e-autonomous-pipeline.ts 2135)
  const argLeadId = process.argv[2] ? parseInt(process.argv[2], 10) : 2135;

  console.log(`📌 Selecionando lead #${argLeadId} para teste do pipeline autônomo...`);

  const { data: lead, error: findError } = await supabaseAdmin
    .from("leads_extraidos")
    .select("*")
    .eq("id", argLeadId)
    .single();

  if (findError || !lead) {
    throw new Error(`Lead #${argLeadId} não encontrado no banco: ${findError?.message}`);
  }

  console.log("📋 Dados do lead:");
  console.log(`   - ID: ${lead.id}`);
  console.log(`   - Nome: ${lead.nome_negocio}`);
  console.log(`   - Ramo: ${lead.ramo_negocio}`);
  console.log(`   - Telefone: ${lead.telefone}`);
  console.log(`   - Endereço: ${lead.endereco}`);
  console.log(`   - Avaliação: ${lead.avaliacao} (${lead.reviews} avaliações)`);
  console.log(`   - Fotos no banco: ${Array.isArray(lead.photos) ? lead.photos.length : 0}`);
  console.log(`   - Status atual: ${lead.previa_status || "novo"}`);
  // 1. Simula o disparo da automação (como faria o automation-worker ou o botão da tela)
  console.log(`\n1️⃣  [AUTOMAÇÃO] Enfileirando lead #${argLeadId} para geração de prévia...`);
  const enqueueTime = new Date().toISOString();
  const { error: enqueueError } = await supabaseAdmin
    .from("leads_extraidos")
    .update({
      previa_status: "PREVIA_SOLICITADA",
      status: "PREVIA_SOLICITADA",
      previa_solicitada_em: enqueueTime,
      previa_error: null,
    })
    .eq("id", argLeadId);

  if (enqueueError) {
    throw new Error(`Erro ao enfileirar lead: ${enqueueError.message}`);
  }

  // 2. Busca o lead da fila (exatamente como o worker autônomo consome)
  console.log("2️⃣  [FILA] Worker autônomo detecta lead com status PREVIA_SOLICITADA...");
  const { data: queuedLead, error: queueFetchError } = await supabaseAdmin
    .from("leads_extraidos")
    .select("*")
    .eq("id", argLeadId)
    .single();

  if (queueFetchError || !queuedLead) {
    throw new Error(`Erro ao resgatar lead da fila: ${queueFetchError?.message}`);
  }

  console.log(`   - Status na fila: ${queuedLead.previa_status} (solicitado em ${queuedLead.previa_solicitada_em})`);
  console.log("\n3️⃣  [PIPELINE] Executando pipeline completo do worker autônomo (Workspace -> OpenCode CLI + Impeccable -> Vercel Deploy -> Triple QA)...");

  const startTime = Date.now();
  const success = await processSingleLeadPreview(queuedLead);
  const totalDurationSeconds = Math.round((Date.now() - startTime) / 1000);

  console.log("\n───────────────────────────────────────────────────────────");
  console.log(`🏁 Execução concluída em ${totalDurationSeconds}s. Sucesso: ${success ? "SIM ✅" : "NÃO ❌"}`);
  console.log("───────────────────────────────────────────────────────────\n");

  // Busca o lead atualizado no banco
  const { data: updatedLead } = await supabaseAdmin
    .from("leads_extraidos")
    .select("*")
    .eq("id", argLeadId)
    .single();

  if (!updatedLead) {
    console.error("Não foi possível buscar o lead atualizado.");
    return;
  }

  console.log("📊 RESULTADO CONSOLIDADO NO BANCO DE DADOS:");
  console.log(`   - previa_status: ${updatedLead.previa_status}`);
  console.log(`   - link_previa: ${updatedLead.link_previa || "nenhum"}`);
  console.log(`   - previa_qa_score: ${updatedLead.previa_qa_score ?? "n/a"}/100`);
  console.log(`   - previa_pronta_em: ${updatedLead.previa_pronta_em || "n/a"}`);
  console.log(`   - previa_ping_enviado_em: ${updatedLead.previa_ping_enviado_em || "n/a"}`);
  if (updatedLead.previa_error) {
    console.log(`   - previa_error: ${updatedLead.previa_error}`);
  }

  if (updatedLead.previa_qa_report) {
    const report = updatedLead.previa_qa_report;
    console.log("\n🔍 DETALHES DO RELATÓRIO TRIPLE QA:");
    console.log(`   - HTTP Status: ${report.http?.status} (${report.http?.responseTimeMs}ms)`);
    console.log(`   - Imagens renderizadas: ${report.dom?.totalImages} (Quebradas: ${report.dom?.brokenImages?.length || 0})`);
    console.log(`   - Overflow horizontal: ${report.dom?.hasHorizontalOverflow ? "SIM ⚠️" : "NÃO ✅"}`);
    console.log(`   - Links de WhatsApp identificados: ${report.dom?.whatsappLinks?.length || 0}`);
    console.log(`   - Score Estético/Vision: ${report.critique?.score ?? report.score}/100`);
    if (report.critique?.summary) {
      console.log(`   - Resumo da IA: "${report.critique.summary}"`);
    }
  }

  // Logs de automação registrados durante o pipeline
  console.log("\n📜 EVENTOS REGISTRADOS EM automation_logs:");
  try {
    const derivedJid =
      typeof updatedLead.remoteJid === "string" && updatedLead.remoteJid.includes("@")
        ? updatedLead.remoteJid
        : typeof updatedLead.telefone === "string" && updatedLead.telefone.replace(/\D/g, "").length >= 10
        ? `${updatedLead.telefone.replace(/\D/g, "")}@s.whatsapp.net`
        : null;

    let q = supabaseAdmin
      .from("automation_logs")
      .select("level, message, created_at")
      .gte("created_at", enqueueTime)
      .order("id", { ascending: true })
      .limit(20);

    if (derivedJid) {
      q = q.eq("remote_jid", derivedJid);
    }

    const { data: logs } = await q;

    if (logs && logs.length > 0) {
      for (const log of logs) {
        const time = new Date(log.created_at).toLocaleTimeString("pt-BR");
        console.log(`   [${time}] [${log.level.toUpperCase()}] ${log.message}`);
      }
    } else {
      console.log("   (Nenhum log filtrado por remote_jid, buscando por texto...)");
      const { data: textLogs } = await supabaseAdmin
        .from("automation_logs")
        .select("level, message, created_at")
        .ilike("message", `%${argLeadId}%`)
        .gte("created_at", enqueueTime)
        .order("id", { ascending: true })
        .limit(20);

      if (textLogs && textLogs.length > 0) {
        for (const log of textLogs) {
          const time = new Date(log.created_at).toLocaleTimeString("pt-BR");
          console.log(`   [${time}] [${log.level.toUpperCase()}] ${log.message}`);
        }
      } else {
        console.log("   (Nenhum log gravado no intervalo)");
      }
    }
  } catch (err: unknown) {
    console.warn("   Aviso: erro ao buscar automation_logs:", err instanceof Error ? err.message : String(err));
  }

  // Teste HTTP ao vivo da URL publicada
  if (updatedLead.link_previa) {
    console.log(`\n🌐 Testando acesso ao vivo ao link gerado: ${updatedLead.link_previa}`);
    try {
      const resp = await fetch(updatedLead.link_previa);
      console.log(`   - Status HTTP: ${resp.status} ${resp.statusText}`);
      const text = await resp.text();
      console.log(`   - Tamanho HTML: ${(text.length / 1024).toFixed(1)} KB`);
      console.log(`   - Contém nome do negócio: ${text.includes(lead.nome_negocio) ? "SIM ✅" : "NÃO ⚠️"}`);
    } catch (e: unknown) {
      console.error(`   - Falha ao acessar URL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n===========================================================\n");
}

main().catch((err) => {
  console.error("\n❌ ERRO FATAL NO TESTE:", err);
  process.exit(1);
});
