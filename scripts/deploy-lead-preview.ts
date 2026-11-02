import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const { deployToVercel } = await import("../src/lib/sites/vercel-deployer");
  const { inspectAutonomousSitePreview } = await import("../src/lib/sites/qa-inspector");
  const { logAutonomousSiteEvent } = await import("../src/lib/sites/autonomous-worker-engine");
  const path = await import("node:path");
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

  console.log("Buscando Lead #1968 no Supabase...");
  const { data: lead, error } = await sb
    .from("leads_extraidos")
    .select("*")
    .eq("id", 1968)
    .single();

  if (error || !lead) {
    console.error("Erro ao buscar lead 1968:", error);
    process.exit(1);
  }

  const leadId = lead.id;
  const nome = lead.nome_negocio || "Espaço Florescer Nail designer by Dani";
  const workspaceDir = path.resolve(process.cwd(), "storage", "previews", String(leadId));

  console.log(`Lead carregado: #${leadId} - ${nome}`);
  console.log(`Usando workspace validado: ${workspaceDir}`);

  // 1. Atualiza status no Supabase para FAZENDO_DEPLOY
  await sb
    .from("leads_extraidos")
    .update({ previa_status: "FAZENDO_DEPLOY" })
    .eq("id", leadId);

  await logAutonomousSiteEvent(lead, `[Site IA] ☁️ Publicando site autônomo na Vercel...`, "info");
  console.log("Iniciando deploy na Vercel...");

  const deployResult = await deployToVercel({
    workspaceDir,
    projectName: `preview-${leadId}-${nome.slice(0, 20)}`,
  });

  if (!deployResult.success || !deployResult.url) {
    console.error("Deploy Vercel falhou:", deployResult.error);
    await sb
      .from("leads_extraidos")
      .update({
        previa_status: "PREVIA_FALHOU",
        previa_error: `Deploy Vercel falhou: ${deployResult.error}`,
      })
      .eq("id", leadId);
    await logAutonomousSiteEvent(lead, `[Site IA] ❌ Falha no deploy: ${deployResult.error}`, "error");
    process.exit(1);
  }

  console.log(`Deploy concluído com sucesso: ${deployResult.url}`);
  await logAutonomousSiteEvent(lead, `[Site IA] 🌐 Site publicado na Vercel: ${deployResult.url}`, "info", { url: deployResult.url });

  // 2. Atualiza status para INSPECIONANDO_QA
  await sb
    .from("leads_extraidos")
    .update({
      previa_status: "INSPECIONANDO_QA",
      link_previa: deployResult.url,
    })
    .eq("id", leadId);

  await logAutonomousSiteEvent(lead, `[Site IA] 🔍 Executando inspeção Triple QA (HTTP + DOM + Visual)...`, "info");
  console.log("Executando inspeção Triple QA...");

  const qaReport = await inspectAutonomousSitePreview({
    url: deployResult.url,
    leadName: nome,
    niche: lead.ramo_negocio || "Manicure",
  });

  console.log(`QA Concluído. Score: ${qaReport.score}/100, Passed: ${qaReport.passed}`);
  console.log(`HTTP OK: ${qaReport.http.ok}, Broken Images: ${qaReport.dom.brokenImages.length}, Overflow: ${qaReport.dom.hasHorizontalOverflow}`);
  console.log(`QA Resumo: ${qaReport.critique.summary}`);

  if (qaReport.passed) {
    await sb
      .from("leads_extraidos")
      .update({
        previa_status: "PREVIA_PRONTA",
        link_previa: deployResult.url,
        previa_pronta_em: new Date().toISOString(),
        previa_qa_score: qaReport.score,
        previa_qa_report: qaReport,
        previa_error: null,
      })
      .eq("id", leadId);

    await logAutonomousSiteEvent(
      lead,
      `[Site IA] ✅ Prévia APROVADA no Triple QA (${qaReport.score}/100)! No ar: ${deployResult.url}`,
      "success",
      { score: qaReport.score, url: deployResult.url }
    );
    console.log(`✅ Sucesso total! Site da cliente está no ar e registrado no Supabase: ${deployResult.url}`);
  } else {
    const issues = [
      !qaReport.http.ok ? "HTTP não retornou 200" : null,
      qaReport.dom.brokenImages.length > 0 ? `${qaReport.dom.brokenImages.length} imagens quebradas` : null,
      qaReport.dom.hasHorizontalOverflow ? "Overflow horizontal no mobile" : null,
      qaReport.score < 75 ? `Score insuficiente (${qaReport.score}/100)` : null,
    ].filter(Boolean).join("; ");

    await sb
      .from("leads_extraidos")
      .update({
        previa_status: "PREVIA_FALHOU",
        previa_qa_score: qaReport.score,
        previa_qa_report: qaReport,
        previa_error: `Reprovado no QA: ${issues}`,
      })
      .eq("id", leadId);

    await logAutonomousSiteEvent(lead, `[Site IA] ❌ Reprovado no QA: ${issues}`, "error", { score: qaReport.score });
    console.warn(`Reprovado no QA: ${issues}`);
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
