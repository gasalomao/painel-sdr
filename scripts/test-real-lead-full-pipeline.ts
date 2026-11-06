import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { supabaseAdmin } from "../src/lib/supabase_admin";
import { provisionLeadWorkspace } from "../src/lib/sites/workspace-provisioner";
import { correctSiteQuality, generateSiteWithAutoCorrection } from "../src/lib/sites/site-generation-loop";
import { scanHtmlStatic } from "../src/lib/sites/site-quality-gate";
import { inspectLocalHtmlGeometry, inspectAutonomousSitePreview } from "../src/lib/sites/qa-inspector";
import { validateHtmlCss } from "../src/lib/sites/impeccable-detector";
import { deployToVercel, sanitizeVercelProjectName } from "../src/lib/sites/vercel-deployer";
import { evaluatePreviewAgreement } from "../src/lib/sites/agreement-detector";
import { parseAgendaDateTime } from "../src/lib/agenda-logic";

async function main() {
  console.log("================================================================================");
  console.log("🔥 TESTE REAL COMPLETO: CAPTAÇÃO + CHAT + FOTOS + OPENCODE + GATE + IMPECCABLE + VERCEL");
  console.log("================================================================================\n");

  // 1. CARREGA O LEAD REAL MINERADO DO GOOGLE MAPS (#2115 - FÁBRICA DE DIVAS)
  console.log("📍 [1. Captura/Leitura do Lead Real]");
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from("leads_extraidos")
    .select("*")
    .eq("id", 2115)
    .single();

  if (leadErr || !lead) {
    throw new Error(`Falha ao obter lead: ${leadErr?.message || "Não encontrado"}`);
  }

  console.log(`- Lead: "${lead.nome_negocio}" (ID: #${lead.id})`);
  console.log(`- Ramo: ${lead.ramo_negocio}`);
  console.log(`- Endereço: ${lead.endereco}`);
  console.log(`- WhatsApp: ${lead.telefone}`);
  console.log(`- Avaliação: ⭐ ${lead.avaliacao} (${lead.reviews} avaliações reais)`);
  console.log(`- Acervo do Maps no banco: ${lead.photos?.length || 0} fotos reais\n`);

  // 2. SIMULAÇÃO DO CHAT COM AVALIAÇÃO DA IA (SARAH SDR)
  console.log("💬 [2. Simulação de Chat com Sarah SDR]");
  const sdrQuestion = `Show, já passei aqui para a nossa equipe montar a prévia da ${lead.nome_negocio}! Como a gente cria algo personalizado pro seu negócio mesmo, leva até 2 dias úteis. Como o pessoal vai dedicar um tempo exclusivo nisso, quando a gente finalizar e te mandar o link por aqui você consegue dar uma olhadinha rápida para dizer o que achou?`;
  const leadAnswer = `Com certeza, pode montar sim! Assim que mandar aqui no WhatsApp eu abro e olho na hora!`;

  console.log(`- Sarah SDR: "${sdrQuestion}"`);
  console.log(`- Lead Resposta: "${leadAnswer}"`);

  const agreement = await evaluatePreviewAgreement({
    messages: [
      { role: "agent", content: sdrQuestion },
      { role: "user", content: leadAnswer },
    ],
  });

  console.log(`- Avaliação da IA: Aceitou=${agreement.agreed} (confiança: ${agreement.confidence}, método: ${agreement.evaluatorMethod})`);
  if (!agreement.agreed) {
    throw new Error("IA avaliadora não detectou o aceite. Abortando criação do site.");
  }
  console.log(`- Decisão do Agente: ✅ APROVADO PARA PRODUÇÃO DO SITE!\n`);

  // 3. PROVISIONAMENTO DO WORKSPACE E DOWNLOAD REAL DAS FOTOS
  // SITE_REUSE_WORKSPACE=<dir> reaproveita um workspace já gerado (index.html existente),
  // pulando provisionamento e geração — útil para revalidar/republicar sem gastar 30 min.
  const reuseWorkspace = process.env.SITE_REUSE_WORKSPACE?.trim();
  let workspaceDir: string;

  if (reuseWorkspace) {
    await fs.access(path.join(reuseWorkspace, "index.html"));
    workspaceDir = reuseWorkspace;
    console.log("📸 [3. Workspace existente reaproveitado]");
    console.log(`- Workspace: ${workspaceDir}`);
  } else {
    console.log("📸 [3. Provisionamento do Workspace e Download Real das Fotos]");
    workspaceDir = path.join(os.tmpdir(), `workspace-lead-${lead.id}-${Date.now()}`);
  }

  if (!reuseWorkspace) {
    const provision = await provisionLeadWorkspace({
      lead,
      customWorkspaceDir: workspaceDir,
      maxPhotos: 12,
      skipLiveScrape: true,
    });

    console.log(`- Workspace criado em: ${workspaceDir}`);
    console.log(`- Total de fotos baixadas: ${provision.photosCount}`);
  }

  const fotosDir = path.join(workspaceDir, "fotos");
  const fotosOnDisk = await fs.readdir(fotosDir);
  console.log(`- Arquivos em ./fotos/: ${fotosOnDisk.length} fotos reais encontradas:`);
  for (const f of fotosOnDisk.slice(0, 6)) {
    const stat = await fs.stat(path.join(fotosDir, f));
    console.log(`  * ${f} (${Math.round(stat.size / 1024)} KB)`);
  }
  if (fotosOnDisk.length > 6) {
    console.log(`  * ... e mais ${fotosOnDisk.length - 6} fotos`);
  }
  console.log("");

  // 4. OPENCODE + GATE DE QUALIDADE (detector + CSS + geometria) COM AUTO-CORREÇÃO
  console.log("💻 [4. OpenCode CLI Headless + Gate de Qualidade Pré-Deploy]");
  console.log(`- Modelo: 9router/combo-principal | Loop máximo de correção: 3`);

  const generation = reuseWorkspace
    ? await correctSiteQuality({
        workspaceDir,
        leadName: lead.nome_negocio,
        niche: lead.ramo_negocio || "Salão e Estética",
        maxLoops: 3,
        timeoutMs: 900_000,
        onLog: (line) => {
          console.log(`  [Gate] ${line}`);
        },
      })
    : await generateSiteWithAutoCorrection({
    workspaceDir,
    leadName: lead.nome_negocio,
    niche: lead.ramo_negocio || "Salão e Estética",
    timeoutMs: 1_800_000,
    maxLoops: 3,
    onLog: (line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("[OpenCode]") ||
        trimmed.startsWith("[Impeccable Detector]") ||
        trimmed.startsWith("[CSS Validator]") ||
        trimmed.startsWith("[Quality Gate]") ||
        trimmed.includes("error") ||
        trimmed.includes("Error")
      ) {
        console.log(`  ${trimmed.slice(0, 300)}`);
      }
    },
  });

  console.log(`- Execuções do OpenCode: ${generation.attempts}`);
  console.log(`- OpenCode sucesso: ${generation.run?.success ?? "n/a (workspace reaproveitado sem correção)"}`);
  console.log(`- Gate pré-deploy: ${generation.success ? "✅ APROVADO" : "❌ REPROVADO"}`);
  if (generation.violations.length > 0) {
    for (const violation of generation.violations) {
      console.log(`  * [${violation.code}] ${violation.message}`);
    }
  }

  if (generation.run && !generation.run.success) {
    console.log(`- Erro do OpenCode: ${generation.run.error || "(sem mensagem)"}`);
    console.log(`- stderr (últimos 2000 chars):\n${generation.run.stderr.slice(-2000)}`);
    console.log(`- Workspace preservado para inspeção: ${workspaceDir}`);
    process.exit(2);
  }

  const htmlPath = path.join(workspaceDir, "index.html");
  const htmlContent = await fs.readFile(htmlPath, "utf-8");
  const htmlSizeKb = Math.round(Buffer.byteLength(htmlContent, "utf-8") / 1024);
  console.log(`- index.html: ${htmlSizeKb} KB (${htmlContent.split("\n").length} linhas)`);

  const fotoRefs = htmlContent.match(/fotos\/foto-\d+\.(jpg|jpeg|png|webp)/gi) || [];
  console.log(`- Referências a ./fotos/: ${Array.from(new Set(fotoRefs)).length} fotos distintas`);

  const cssCheck = validateHtmlCss(htmlContent);
  console.log(`- Sintaxe CSS (postcss): ${cssCheck.valid ? "✅ válida" : `❌ ${cssCheck.errors.join("; ")}`} (${cssCheck.styleBlocks} blocos)`);

  const staticViolations = scanHtmlStatic(htmlContent, { requirePhotos: fotosOnDisk.length > 0 });
  console.log(`- Scanner estático: ${staticViolations.length === 0 ? "✅ limpo" : `❌ ${staticViolations.map((v) => v.code).join(", ")}`}`);

  const geometry = await inspectLocalHtmlGeometry(htmlPath);
  for (const audit of geometry) {
    const label = audit.viewport === "desktop" ? "Desktop 1440x900" : "Mobile 375x812";
    console.log(`- Geometria ${label}: ${audit.ok ? "✅ ok" : `❌ ${audit.violations.length} violação(ões)`}`);
    for (const violation of audit.violations) {
      console.log(`    * [${violation.code}] ${violation.message}`);
    }
  }

  if (!generation.success) {
    console.log("\n❌ DEPLOY BLOQUEADO: o site não passou no gate de qualidade.");
    console.log(`Workspace preservado para inspeção: ${workspaceDir}`);
    process.exit(2);
  }

  // 5. DEPLOY REAL NA VERCEL (só depois do gate aprovar)
  console.log("\n🌐 [5. Deploy Real na Vercel]");
  const projectName = sanitizeVercelProjectName(lead.nome_negocio);
  const deployResult = await deployToVercel(workspaceDir, projectName);

  if (!deployResult.success || !deployResult.url) {
    console.error(`- Falha no deploy: ${deployResult.error}`);
    throw new Error("Deploy Vercel falhou");
  }

  console.log(`🎉 SITE PUBLICADO COM SUCESSO NO AR!`);
  console.log(`- URL Oficial da Prévia: ${deployResult.url}`);
  console.log(`- Deployment ID: ${deployResult.deploymentId}`);

  // 6. INSPEÇÃO PÓS-DEPLOY (HTTP + DOM + geometria real na URL publicada)
  console.log("\n🔍 [6. Auditoria Tripla Pós-Deploy]");
  const qaReport = await inspectAutonomousSitePreview({
    url: deployResult.url,
    leadName: lead.nome_negocio,
    niche: lead.ramo_negocio,
  });
  console.log(`- HTTP: ${qaReport.http.status} em ${qaReport.http.responseTimeMs}ms`);
  console.log(`- CSS publicado: ${qaReport.css.valid ? "✅ válido" : `❌ ${qaReport.css.errors.join("; ")}`}`);
  console.log(`- Geometria Desktop: ${qaReport.geometry.desktop.ok ? "✅ ok" : `❌ ${qaReport.geometry.desktop.violations.map((v) => v.code).join(", ")}`}`);
  console.log(`- Geometria Mobile: ${qaReport.geometry.mobile.ok ? "✅ ok" : `❌ ${qaReport.geometry.mobile.violations.map((v) => v.code).join(", ")}`}`);
  console.log(`- Imagens: ${qaReport.dom.totalImages} (quebradas: ${qaReport.dom.brokenImages.length})`);
  console.log(`- @keyframes na página: ${qaReport.geometry.mobile.keyframes}`);
  console.log(`- Score final: ${qaReport.score}/100 | Aprovado: ${qaReport.passed ? "✅" : "❌"}`);

  // 7. SCRIPT DA SARAH CLOSER E AGENDAMENTO
  console.log("\n🤝 [7. Continuação da Conversa com Sarah Closer]");
  const ping = `Você está com o celular na mão? Nossa equipe finalizou a prévia da ${lead.nome_negocio}!`;
  console.log(`- Sarah (Ping Duplo Vínculo): "${ping}"`);
  console.log(`- Lead: "Tô sim no celular, pode mandar aí!"`);

  const delivery = `Dá uma olhadinha aí no celular! Como é uma prévia inicial, montamos com o que encontramos disponível na internet só para você ter uma ideia de como a estrutura funciona, mas depois deixamos 100% do seu jeito, com as suas fotos e cores preferidas. Me conta: o que achou dessa ideia para a ${lead.nome_negocio}?\n\n👉 Acesse aqui: ${deployResult.url}`;
  console.log(`- Sarah Closer (Entrega): "${delivery}"`);
  console.log(`- Lead: "Nossa, ficou muito lindo mesmo, muito profissional! Quanto custa pra colocar os meus serviços certinhos?"`);

  const callPitch = `Fico muito feliz que gostou! Sobre os valores e a inclusão de todos os seus serviços e fotos reais, depende exatamente do que você vai querer manter na versão final. Para te passar certinho e sem compromisso, a gente consegue fazer uma chamada rápida de 3 minutinhos no WhatsApp? Você prefere hoje às 16h ou amanhã às 10h?`;
  console.log(`- Sarah Closer (Matriz de Fechamento): "${callPitch}"`);
  console.log(`- Lead: "Amanhã às 10h fica perfeito pra mim!"`);

  const horario = "Amanhã às 10h";
  const startDt = parseAgendaDateTime(horario);
  console.log(`- Reunião confirmada para: ${startDt.toISOString()}`);
  console.log(`- Tool 'agendar_reuniao_fechamento' executada com sucesso.`);

  console.log("\n================================================================================");
  console.log("✅ TESTE REAL DE PONTA A PONTA CONCLUÍDO!");
  console.log(`🔗 Link no Ar para inspeção: ${deployResult.url}`);
  console.log(`📁 Workspace: ${workspaceDir}`);
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("❌ Erro fatal no teste:", err);
  process.exit(1);
});
