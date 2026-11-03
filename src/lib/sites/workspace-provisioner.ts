import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  mergeMapsKitData,
  downloadAllPlacePhotos,
  formatLeadKitTxt,
  scrapeGoogleMapsPlaceForKit,
  type EnrichedLeadKitData,
} from "@/lib/lead-maps-kit";
import {
  extractWhatsAppConversationContext,
  type WhatsAppExtractedInsights,
} from "./whatsapp-context-extractor";
import { supabaseAdmin } from "@/lib/supabase_admin";

export interface ProvisionWorkspaceOptions {
  lead: Record<string, unknown>;
  maxPhotos?: number;
  customWorkspaceDir?: string;
  supabaseClient?: any;
  skipLiveScrape?: boolean;
}

export interface ProvisionWorkspaceResult {
  workspaceDir: string;
  photosDir: string;
  txtPath: string;
  photosCount: number;
  insights: WhatsAppExtractedInsights;
  leadData: EnrichedLeadKitData;
}

/**
 * Monta o diretório de workspace isolado para geração do site pelo OpenCode CLI na VPS.
 * 1. Baixa as fotos em alta resolução do Google Maps para ./fotos/
 * 2. Minera particularidades operacionais no histórico do WhatsApp (links de agenda, PIX)
 * 3. Escreve o arquivo oficial INFORMACOES-DO-NEGOCIO.txt
 */
export async function provisionLeadWorkspace(
  opts: ProvisionWorkspaceOptions
): Promise<ProvisionWorkspaceResult> {
  const {
    lead,
    maxPhotos = 120,
    customWorkspaceDir,
    skipLiveScrape = process.env.NODE_ENV === "test",
  } = opts;
  const leadId = lead.id ? String(lead.id) : `lead-${Date.now()}`;

  // Determina diretório temporário: /tmp no Linux ou temp dir do SO
  const baseDir = customWorkspaceDir || path.join(os.tmpdir(), `workspace-${leadId}`);
  const photosDir = path.join(baseDir, "fotos");

  // Cria estrutura de pastas
  await fs.mkdir(photosDir, { recursive: true });

  // 1. Extração de inteligência do WhatsApp
  const remoteJid = typeof lead.remoteJid === "string" ? lead.remoteJid : "";
  const clientId = typeof lead.client_id === "string" ? lead.client_id : "";
  const insights = await extractWhatsAppConversationContext(remoteJid, clientId, opts.supabaseClient || supabaseAdmin);

  // 2. Extração completa de dados e fotos do Google Maps via Kit Site (se o lead ainda tiver poucas fotos no banco)
  let scraped = null;
  const currentPhotos = Array.isArray(lead.photos) ? lead.photos : [];
  const validPhotos = currentPhotos.filter(
    (p: any) => typeof p === "string" && !p.includes("/a/") && !p.includes("/a-/")
  );

  // Se o lead tiver menos de 5 fotos válidas salvas e possuir maps_url ou nome, roda o scraper do Kit Site
  if (!skipLiveScrape && validPhotos.length < 5 && (lead.maps_url || lead.nome_negocio)) {
    try {
      console.log(`[workspace-provisioner] 📸 Acionando scraper completo do Kit Site para capturar todo o acervo do Maps...`);
      scraped = await scrapeGoogleMapsPlaceForKit({
        mapsUrl: typeof lead.maps_url === "string" ? lead.maps_url : null,
        nomeNegocio: typeof lead.nome_negocio === "string" ? lead.nome_negocio : null,
        endereco: typeof lead.endereco === "string" ? lead.endereco : null,
        telefone: typeof lead.telefone === "string" ? lead.telefone : null,
      });
      if (scraped?.photos && scraped.photos.length > 0) {
        console.log(`[workspace-provisioner] 📸 Kit Site capturou ${scraped.photos.length} fotos do Google Maps com sucesso!`);
      }
    } catch (scErr: any) {
      console.warn("[workspace-provisioner] Falha ao extrair fotos com Kit Site:", scErr?.message);
    }
  }

  // Mescla dados do Lead (Maps e CRM) com os dados capturados pelo Kit Site
  const enrichedData = mergeMapsKitData(lead, scraped);

  // Se coletou fotos novas via Kit Site, persiste no banco em background para acelerar próximas chamadas
  if (scraped && enrichedData.fotosUrls.length > validPhotos.length && lead.id) {
    try {
      const client = opts.supabaseClient || supabaseAdmin;
      await client
        .from("leads_extraidos")
        .update({
          photos: enrichedData.fotosUrls,
          total_photo_count: enrichedData.totalFotosDeclarado || enrichedData.fotosUrls.length,
          business_details: {
            ...(typeof lead.business_details === "object" && lead.business_details !== null && !Array.isArray(lead.business_details)
              ? (lead.business_details as Record<string, unknown>)
              : {}),
            _mapsKitEnrichedAt: new Date().toISOString(),
            ...(scraped.about ? { about: scraped.about } : {}),
            ...(scraped.services?.length ? { services: scraped.services } : {}),
          },
        })
        .eq("id", lead.id);
    } catch (upErr: any) {
      console.warn("[workspace-provisioner] Aviso ao atualizar lead com fotos do kit:", upErr?.message);
    }
  }

  // 3. Download paralelo das fotos em alta resolução (todas as disponíveis sem limite baixo)
  const downloadedPhotos = await downloadAllPlacePhotos(
    enrichedData.fotosUrls,
    maxPhotos
  );

  // Escreve cada foto baixada no disco dentro de fotos/
  let writtenPhotos = 0;
  for (const photo of downloadedPhotos) {
    if (photo.data && photo.data.length > 0) {
      const filePath = path.join(photosDir, photo.fileName);
      await fs.writeFile(filePath, photo.data);
      writtenPhotos++;
    }
  }

  // 4. Formata o briefing oficial com as fotos escritas
  let txtContent = formatLeadKitTxt(enrichedData, downloadedPhotos);

  // Injeta seção adicional com regras do WhatsApp caso existam
  if (insights.rawSummary) {
    const whatsappSection = [
      "",
      "================================================================================",
      "5. INFORMAÇÕES EXCLUSIVAS COLETADAS VIA WHATSAPP (REGRAS DE AGENDAMENTO E PIX)",
      "--------------------------------------------------------------------------------",
      insights.rawSummary,
      "================================================================================",
      "",
    ].join("\n");

    txtContent += "\n" + whatsappSection;
  }

  const txtPath = path.join(baseDir, "INFORMACOES-DO-NEGOCIO.txt");
  await fs.writeFile(txtPath, txtContent, "utf-8");

  // 5. Prepara PRODUCT.md para a skill Impeccable do OpenCode ler contexto nativamente
  const nomeNegocio = enrichedData.nomeNegocio || "Empresa Local";
  const ramoNegocio = enrichedData.ramoNegocio || "Serviços Especializados";
  const productMdContent = [
    `# Product: ${nomeNegocio}`,
    "",
    "<!-- impeccable:product-schema 1 -->",
    "",
    "## Platform",
    "web",
    "",
    "## Stack",
    "HTML5 semântico, CSS moderno estruturado com design tokens (:root variáveis CSS), zero build step.",
    "",
    "## Users",
    `Moradores, clientes residenciais e comerciais que necessitam de ${ramoNegocio} com agilidade, excelência, confiança e contato direto pelo WhatsApp.`,
    "",
    "## Product Purpose",
    `Landing page comercial autoral, persuasiva e esteticamente impecável para ${nomeNegocio}, apresentando serviços especializados, fotos reais do estabelecimento, depoimentos reais do Google Maps e canais imediatos de agendamento via WhatsApp.`,
    "",
    "## Mode",
    "persuade",
    "",
    "## Positioning",
    `Referência em ${ramoNegocio}, destacando-se por pontualidade, atendimento personalizado, ambiente de alto padrão e credibilidade comprovada.`,
    "",
    "## Brand Commitments",
    `Nome: ${nomeNegocio}`,
    `Nicho: ${ramoNegocio}`,
    `Aesthetic: Design contemporâneo exclusivo, ausência total de templates genéricos ou AI slop, contraste WCAG AA, paleta derivada do ambiente físico real e galeria rica com fotos reais de ./fotos/.`,
    "",
    "## Evidence on Hand",
    `${writtenPhotos} fotos reais da empresa na pasta ./fotos/, depoimentos reais de clientes e informações completas de contato e endereço em INFORMACOES-DO-NEGOCIO.txt.`,
    "",
    "## Product Principles",
    "1. Conversão Persuasiva: O visitante entende a oferta em segundos e tem ação clara via WhatsApp.",
    "2. Prova Real e Autenticidade: Utilização das fotos reais da pasta ./fotos/ e depoimentos autênticos do Google Maps.",
    "3. Craft Floor Impeccable: Zero clichês de IA (sem kickers, sem cards idênticos, sem gradientes de texto, sem emojis em ícones).",
    "",
  ].join("\n");

  const productMdPath = path.join(baseDir, "PRODUCT.md");
  await fs.writeFile(productMdPath, productMdContent, "utf-8");

  // 6. Prepara AGENTS.md com o Protocolo Obrigatório de Frontend (Impeccable Engine)
  const agentsMdContent = generateAgentsMdForWorkspace(nomeNegocio);
  const agentsMdPath = path.join(baseDir, "AGENTS.md");
  await fs.writeFile(agentsMdPath, agentsMdContent, "utf-8");

  // 7. Prepara DESIGN.md com arquitetura técnica oficial Impeccable (tokens :root, clamp, grids, motion)
  const designMdContent = generateDesignMdForLead(enrichedData, writtenPhotos);
  const designMdPath = path.join(baseDir, "DESIGN.md");
  await fs.writeFile(designMdPath, designMdContent, "utf-8");

  // 8. Garante que todas as skills do OpenCode estejam disponíveis dentro do workspace
  await ensureWorkspaceOpencode(baseDir);

  // Atualiza banco com insights minerados
  if (lead.id && supabaseAdmin) {
    try {
      await supabaseAdmin
        .from("leads_extraidos")
        .update({
          previa_whatsapp_insights: insights,
          previa_status: "GERANDO_WORKSPACE",
        })
        .eq("id", lead.id);
    } catch (e: any) {
      console.warn("[workspace-provisioner] Aviso ao atualizar lead:", e?.message);
    }
  }

  return {
    workspaceDir: baseDir,
    photosDir,
    txtPath,
    photosCount: writtenPhotos,
    insights,
    leadData: enrichedData,
  };
}

/**
 * Garante que o catálogo de skills do OpenCode (.opencode/skills) esteja disponível no workspace isolado.
 * Usa symlink/junction em 0ms; fallback para cópia seletiva.
 */
export async function ensureWorkspaceOpencode(workspaceDir: string): Promise<void> {
  const targetOpencode = path.join(workspaceDir, ".opencode");
  try {
    const stat = await fs.stat(targetOpencode).catch(() => null);
    if (stat) return; // já existe

    const candidates = [
      path.resolve(process.cwd(), ".opencode"),
      path.join(os.homedir(), ".config", "opencode"),
      "/home/nextjs/.config/opencode",
      "/app/.opencode",
      "/root/.config/opencode",
    ];

    let sourceDir: string | null = null;
    for (const c of candidates) {
      try {
        const s = await fs.stat(c);
        if (s.isDirectory()) {
          sourceDir = c;
          break;
        }
      } catch {}
    }

    if (!sourceDir) return;

    const isWin = process.platform === "win32";
    try {
      await fs.symlink(sourceDir, targetOpencode, isWin ? "junction" : "dir");
    } catch {
      await fs.cp(sourceDir, targetOpencode, { recursive: true });
    }
  } catch (err: any) {
    console.warn("[workspace-provisioner] Não foi possível vincular .opencode:", err?.message);
  }
}

/**
 * Gera o arquivo AGENTS.md oficial da arquitetura Impeccable (impeccable.style)
 * que atua como camada de governança estética e engenharia de interface acoplada
 * diretamente ao contexto do OpenCode CLI e agentes de frontend.
 */
export function generateAgentsMdForWorkspace(nomeNegocio: string): string {
  return [
    `# AGENTS.md — Protocolo de Engenharia & Design: ${nomeNegocio}`,
    "",
    "## Protocolo Obrigatório de Frontend (Impeccable Engine)",
    "1. **Leitura Prévia**: Antes de criar ou editar qualquer arquivo `.tsx`, `.jsx`, `.html` ou `.css`, leia integralmente o arquivo `DESIGN.md` e `INFORMACOES-DO-NEGOCIO.txt`.",
    "2. **Zero Valores Mágicos**: Consuma exclusivamente os tokens semânticos definidos em `:root` (`--surface-canvas`, `--surface-elevated`, `--surface-interactive`, `--surface-glass`, `--ink-primary`, `--ink-secondary`, `--ink-muted`, `--ink-on-accent`, `--accent-primary`, `--accent-hover`, `--accent-subtle`, `--border-hairline`, `--border-strong`).",
    "3. **Invocação Canônica do Impeccable**: Use o comando canônico `/impeccable` para ativar a skill no OpenCode CLI. Nunca use macros inexistentes como `/create`.",
    "4. **Zero Anti-Patterns do Craft Floor (Detector Oficial Impeccable)**:",
    "   - PROIBIDO [dark-glow]: Nenhum box-shadow ou text-shadow com glow/halo colorido (#dca64e ou similar) ou blur colorido em fundo escuro. Use sombras de elevação neutras (ex: 0 10px 30px rgba(0,0,0,0.4)) e bordas hairlines.",
    "   - PROIBIDO [icon-tile-stack]: Nunca coloque uma caixinha/tile de ícone quadrada ou arredondada empilhada em cima de um título h3 ou h2. Coloque ícones inline ao lado do título ou integre o texto editorial em fluxo sem caixinhas de ícone.",
    "   - PROIBIDO [italic-serif-display]: Nunca use fonte serifada em itálico em títulos h1/h2 display (Cormorant Garamond, Fraunces ou Playfair em itálico). Use font-style: normal e fontes display fortes (Syne, Outfit, Cinzel roman).",
    "   - PROIBIDO [cramped-padding]: Garanta espaçamento generoso interno. Toda seção com border-bottom deve ter padding vertical de pelo menos 5rem a 6rem. Todo card com borda ou fundo deve ter padding interno de pelo menos 1.5rem (24px) para que o texto nunca fique colado na borda.",
    "   - PROIBIDO [overused-font]: Nunca use Inter, Roboto, Fraunces, Geist, Plus Jakarta Sans ou Space Grotesk. Use DM Sans, Syne, Outfit, Manrope ou Satoshi.",
    "   - PROIBIDO [nested-cards]: Nunca aninhe um card dentro de outro card. Mantenha a hierarquia plana.",
    "5. **Critério de Pronto (DoD)**: Só considere a tarefa concluída após o arquivo `index.html` ter sido gerado com 100% de conformidade com o craft floor (zero anti-patterns no detector), usando fotos reais de `./fotos/` e informações de `INFORMACOES-DO-NEGOCIO.txt`.",
  ].join("\n");
}

/**
 * Gera o DESIGN.md técnico e visual para a skill Impeccable guiar a construção do site.
 * Focado em design autoral, Craft Floor estrito (anti-slop) e análise das fotos reais.
 */
export function generateDesignMdForLead(data: EnrichedLeadKitData, photosCount: number): string {
  const niche = (data.ramoNegocio || "").toLowerCase();

  let archetype = "Brutalismo Editorial de Alto Contraste / Luxo Contemporâneo";
  let suggestedAtmosphere = "Atmosfera precisa, magnética, autoral e com contraste refinado.";
  let displayFont = "'Syne', sans-serif";
  let sansFont = "'DM Sans', system-ui, -apple-system, sans-serif";
  const monoFont = "'JetBrains Mono', monospace";

  // Tokens de cor calibrados com espaço OKLCH para cada atmosfera
  let surfaceCanvas = "oklch(12% 0.01 260)";       // #08080A
  let surfaceElevated = "oklch(16% 0.01 260)";     // #111115
  let surfaceInteractive = "oklch(20% 0.015 260)"; // #1A1A20
  let surfaceGlass = "oklch(16% 0.01 260 / 0.78)";
  let inkPrimary = "oklch(96% 0.01 90)";           // #F5F3EF
  let inkSecondary = "oklch(72% 0.01 260)";        // #A3A3AE
  let inkMuted = "oklch(50% 0.01 260)";            // #686873
  let inkOnAccent = "oklch(98% 0.005 90)";
  let accentPrimary = "oklch(58% 0.22 28)";        // rubi / vermelho editorial
  let accentHover = "oklch(64% 0.23 28)";
  let accentSubtle = "oklch(58% 0.22 28 / 0.12)";
  let borderHairline = "oklch(96% 0.01 90 / 0.10)";
  let borderStrong = "oklch(96% 0.01 90 / 0.24)";

  if (niche.includes("bronze") || niche.includes("estét") || niche.includes("beleza") || niche.includes("spa") || niche.includes("manicure") || niche.includes("unha") || niche.includes("nail")) {
    archetype = "Estúdio & Spa Autoral / Luxo Sensorial Contemporâneo";
    suggestedAtmosphere = "Iluminação calorosa e límpida, tons champagne, âmbar suave e contrastes nobres com superfícies de estúdio de beleza autoral.";
    displayFont = "'Syne', 'Outfit', sans-serif";
    sansFont = "'DM Sans', system-ui, -apple-system, sans-serif";
    surfaceCanvas = "oklch(14% 0.02 55)";
    surfaceElevated = "oklch(18% 0.025 55)";
    surfaceInteractive = "oklch(24% 0.03 55)";
    surfaceGlass = "oklch(16% 0.02 55 / 0.82)";
    inkPrimary = "oklch(97% 0.015 80)";
    inkSecondary = "oklch(78% 0.025 70)";
    inkMuted = "oklch(58% 0.02 60)";
    inkOnAccent = "oklch(16% 0.02 55)";
    accentPrimary = "oklch(72% 0.16 75)"; // ouro solar nobre / champagne
    accentHover = "oklch(78% 0.17 75)";
    accentSubtle = "oklch(72% 0.16 75 / 0.14)";
    borderHairline = "oklch(72% 0.16 75 / 0.20)";
    borderStrong = "oklch(72% 0.16 75 / 0.38)";
  } else if (niche.includes("barbear") || niche.includes("barber")) {
    archetype = "Artesanal Urbano / Elegância Brutalista Clássica";
    suggestedAtmosphere = "Preto fosco, textura de couro envelhecido, âmbar tostado e tipografia forte de alta precisão.";
    displayFont = "'Syne', 'Outfit', sans-serif";
    sansFont = "'DM Sans', system-ui, -apple-system, sans-serif";
    surfaceCanvas = "oklch(13% 0.01 60)";
    surfaceElevated = "oklch(17% 0.015 60)";
    accentPrimary = "oklch(66% 0.18 52)";
    accentHover = "oklch(72% 0.19 52)";
    accentSubtle = "oklch(66% 0.18 52 / 0.14)";
    borderHairline = "oklch(96% 0.01 90 / 0.12)";
  } else if (niche.includes("odont") || niche.includes("clínic") || niche.includes("saúde") || niche.includes("médic")) {
    archetype = "Serenidade Clínica / Precisão e Confiança";
    suggestedAtmosphere = "Superfícies limpas, azuis profundos, brancos arejados com toques terapêuticos e precisão visual inabalável.";
    displayFont = "'Cabinet Grotesk', 'Syne', sans-serif";
    sansFont = "'DM Sans', system-ui, -apple-system, sans-serif";
    surfaceCanvas = "oklch(13% 0.02 245)";
    surfaceElevated = "oklch(18% 0.025 245)";
    accentPrimary = "oklch(65% 0.16 235)";
    accentHover = "oklch(70% 0.17 235)";
    accentSubtle = "oklch(65% 0.16 235 / 0.15)";
    borderHairline = "oklch(65% 0.16 235 / 0.20)";
  } else if (niche.includes("restaur") || niche.includes("pizz") || niche.includes("padar") || niche.includes("café")) {
    archetype = "Gastronomia Sensorial / Calor Humano e Sabor";
    suggestedAtmosphere = "Terracota, carvão profundo, mostarda tostada e contrastes táteis apetitosos.";
    displayFont = "'Syne', sans-serif";
    sansFont = "'DM Sans', system-ui, -apple-system, sans-serif";
    surfaceCanvas = "oklch(13% 0.02 35)";
    surfaceElevated = "oklch(18% 0.025 35)";
    accentPrimary = "oklch(62% 0.22 35)";
    accentHover = "oklch(68% 0.23 35)";
    accentSubtle = "oklch(62% 0.22 35 / 0.15)";
    borderHairline = "oklch(62% 0.22 35 / 0.22)";
  }

  return [
    `# DESIGN.md — Especificação do Sistema de Design: ${data.nomeNegocio}`,
    "",
    "<!-- impeccable:design-tokens 1 -->",
    "",
    "## 1. Direção de Arte e Identidade",
    `- **Negócio**: ${data.nomeNegocio}`,
    `- **Segmento**: ${data.ramoNegocio || "Serviços Especializados"}`,
    `- **Arquétipo Estético**: ${archetype}`,
    "- **Tom Emocional**: Preciso, magnético, autoral e direto ao ponto.",
    `- **Atmosfera Visual**: ${suggestedAtmosphere}`,
    "- **Modo Impeccable**: persuade (conversão comercial direta com identidade visual de alta costura).",
    "- **Referências Visuais**: Editoriais impressos de arquitetura, Awwwards Site of the Day, interfaces suíças baseadas em grid exposto.",
    "- **Regra de Ouro**: Cada dobra deve ter exatamente um ponto focal dominante; o espaço negativo e as linhas de 1px estruturam a informação sem depender de cartões sombreados.",
    "",
    "## 2. Sistema de Cores e Tokens Semânticos (CSS Variables)",
    "Nunca utilize cores hexadecimais diretamente nos componentes. Consuma exclusivamente os tokens abaixo em `:root`:",
    "",
    "```css",
    ":root {",
    "  /* Superfícies (Fundo e Camadas) */",
    `  --surface-canvas: ${surfaceCanvas};       /* Fundo principal profundo */`,
    `  --surface-elevated: ${surfaceElevated};   /* Seções secundárias e blocos */`,
    `  --surface-interactive: ${surfaceInteractive}; /* Hover de cartões e inputs */`,
    `  --surface-glass: ${surfaceGlass}; /* Cabeçalhos fixos com blur */`,
    "",
    "  /* Tipografia e Ícones (Ink) */",
    `  --ink-primary: ${inkPrimary};           /* Texto principal off-white quente */`,
    `  --ink-secondary: ${inkSecondary};        /* Subtítulos e parágrafos de apoio */`,
    `  --ink-muted: ${inkMuted};            /* Metadados, legendas e placeholders */`,
    `  --ink-on-accent: ${inkOnAccent};        /* Texto sobre cor de destaque */`,
    "",
    "  /* Acentos de Marca e Conversão */",
    `  --accent-primary: ${accentPrimary};        /* Destaque principal de conversão */`,
    `  --accent-hover: ${accentHover};          /* Estado hover do destaque */`,
    `  --accent-subtle: ${accentSubtle};  /* Fundo de badges e alertas de marca */`,
    "",
    "  /* Bordas e Divisores */",
    `  --border-hairline: ${borderHairline};/* Linhas estruturais de 1px */`,
    `  --border-strong: ${borderStrong};  /* Bordas em foco ou destaque */`,
    "",
    "  /* Estados Semânticos */",
    "  --status-success: oklch(72% 0.17 152);",
    "  --status-warning: oklch(80% 0.16 80);",
    "  --status-danger: oklch(62% 0.20 25);",
    "}",
    "```",
    "",
    "## 3. Engenharia Tipográfica",
    `- **Fonte Display (Títulos e Números de Impacto)**: ${displayFont} (font-style: normal OBRIGATÓRIO, line-height: 0.96 a 1.05, letter-spacing: -0.02em).`,
    `- **Fonte Corpo (Interface e Leitura)**: ${sansFont} (line-height: 1.6, largura máxima de 65ch).`,
    `- **Fonte Técnica (Labels, Índices, Preços, Horários)**: ${monoFont} (font-size: 0.75rem, letter-spacing: 0.08em, uppercase, tabular-nums).`,
    "- **Restrição de Fontes do Impeccable**: Proibido usar fontes censuradas (Plus Jakarta Sans, Inter, Roboto, Fraunces, Geist, Space Grotesk). NUNCA utilize fontes display em itálico (proibido Cormorant Garamond itálico ou Playfair itálico).",
    "",
    "### Escala Modular Fluida",
    "- Display Hero: `clamp(2.75rem, 6vw + 1rem, 6.5rem)`",
    "- H1 Seção: `clamp(2rem, 4vw + 0.5rem, 4rem)`",
    "- H2 Bloco: `clamp(1.5rem, 2.5vw + 0.5rem, 2.5rem)`",
    "- H3 Subtítulo: `clamp(1.15rem, 1.5vw + 0.35rem, 1.45rem)`",
    "- Body Regular: `clamp(1rem, 0.4vw + 0.85rem, 1.125rem)`",
    "- Micro / Tag: `0.75rem` (12px fixo com letter-spacing: 0.08em)",
    "",
    "## 4. Arquitetura Espacial e Grid",
    "- **Container Máximo**: 1440px com padding lateral fluido `clamp(1.25rem, 4vw, 4rem)`.",
    "- **Sistema de Grid**: 12 colunas no desktop (gap: 1.5rem), 4 colunas no mobile (gap: 1rem).",
    "- **Espaçamento de Seção**: `padding-block: clamp(4.5rem, 9vw, 8.5rem)`.",
    "- **Raios de Borda**: 0px para seções estruturais de grid exposto; 4px a 8px para botões e inputs técnicos.",
    "- **Divisores Hairline**: Substituição de caixas sombreadas por linhas divisórias de 1px solid `var(--border-hairline)`.",
    "",
    "## 5. Física de Movimento e Interação",
    "- **Curva Padrão (Out-Expo)**: `cubic-bezier(0.16, 1, 0.3, 1)` com duração de 500ms para revelações de layout.",
    "- **Curva Microinteração**: `cubic-bezier(0.22, 1, 0.36, 1)` com duração de 200ms para estados de `:hover` e `:active`.",
    "- **Regras de Scroll**: Elementos entram com `translateY(24px)` para 0 e `opacity: 0` para 1, escalonados em 60ms por item (`animation-delay: calc(var(--index) * 60ms)`).",
    "- **Acessibilidade**: Obrigatório `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }`.",
    "",
    "## 6. Restrições Absolutas do Craft Floor (Zero Anti-Patterns no Detector Oficial Impeccable)",
    "- **PROIBIDO [dark-glow]**: Nenhum box-shadow ou text-shadow com glow/halo colorido (#dca64e ou similar) ou blur colorido em fundo escuro. Use sombras de elevação neutras (ex: 0 10px 30px rgba(0,0,0,0.4)) e bordas hairlines.",
    "- **PROIBIDO [icon-tile-stack]**: Nunca coloque uma caixinha/tile de ícone quadrada ou arredondada empilhada em cima de um título h3 ou h2. Coloque ícones inline ao lado do título ou integre o texto editorial em fluxo sem caixinhas de ícone.",
    "- **PROIBIDO [italic-serif-display]**: Nunca use fonte serifada em itálico em títulos h1/h2 display (Cormorant Garamond, Fraunces ou Playfair em itálico). Use font-style: normal e fontes display fortes (Syne, Outfit).",
    "- **PROIBIDO [cramped-padding]**: Garanta espaçamento generoso interno. Toda seção com border-bottom deve ter padding vertical de pelo menos 5rem a 6rem. Todo card com borda ou fundo deve ter padding interno de pelo menos 1.75rem (28px).",
    "- **PROIBIDO [overused-font]**: Inter, Roboto, Fraunces, Geist, Plus Jakarta Sans e Space Grotesk são proibidos. Use DM Sans e Syne.",
    "- **PROIBIDO [nested-cards]**: Nunca aninhe um card dentro de outro card. Mantenha a hierarquia plana.",
    "- **PROIBIDO** kickers/eyebrows fracos em caixa alta acima de títulos (ex: nada de '.section-eyebrow' como 'SOBRE NÓS' ou 'NOSSOS DIFERENCIAIS' acima do h2).",
    "- **PROIBIDO** inventar métricas falsas ('100% Satisfação', '5000+ Clientes'). Use apenas a nota real e total de avaliações do Google Maps catalogados em INFORMACOES-DO-NEGOCIO.txt.",
    "- **PROIBIDO** usar emojis como ícones (✨, 🚀, 📞). Use apenas ícones SVG inline com stroke consistente (1.5px a 2px).",
    "",
    "",
    "## 7. Curadoria Fotográfica Completa do Kit Site (Uso Mandatório de Todas as Fotos)",
    `- O Kit Site baixou e catalogou ${photosCount} fotos reais autênticas em ./fotos/ (foto-01 até foto-${String(photosCount).padStart(2, "0")}).`,
    "- **PROIBIDO MONOFOTO**: É estritamente PROIBIDO usar apenas 1 foto ou repetir a mesma imagem em vários cards e seções.",
    "- **DISTRIBUIÇÃO MANDATÓRIA DE FOTOS PELO SITE**:",
    "  * **Hero Section**: 1 foto principal de impacto ou composição assimétrica com 2 a 3 fotos reais (ex: fotos/foto-01.jpg, fotos/foto-02.jpg).",
    "  * **Serviços & Procedimentos**: Cada serviço listado DEVE ter sua própria foto real correspondente ilustrando o procedimento (ex: fotos/foto-03.jpg, fotos/foto-04.jpg, fotos/foto-05.jpg, fotos/foto-06.jpg).",
    "  * **Galeria de Portfólio / Resultados Reais**: Seção de galeria rica em grid moderno ou mosaico exibindo no mínimo 6 a 12 fotos reais distintas (ex: fotos/foto-07.jpg até fotos/foto-18.jpg), com legendas autênticas.",
    "  * **Espaço / Ambiente / Biossegurança**: Fotos reais do local físico, bancadas e recepção (ex: fotos/foto-19.jpg em diante).",
    "- Cada tag `<img>` deve ter loading='lazy', width, height e alt descritivo semântico.",
    "- Harmonize as cores da interface com os tons vistos no ambiente físico das fotos.",
    "- Botões de ação com link wa.me contextualizado e botão flutuante com pulso suave.",
    "- Zero horizontal overflow: `html, body { overflow-x: hidden; width: 100%; scroll-behavior: smooth; }` e `img { max-width: 100%; height: auto; }`.",
    "",
    "## 8. Detalhes de Superfície & Ergonomia",
    "- Estilize `::selection` com cores da marca (`background: var(--accent-subtle); color: var(--ink-primary);`).",
    "- Focus visible nítido (`outline: 2px solid var(--accent-primary); outline-offset: 2px`).",
    "- Header dinâmico translúcido (`backdrop-filter: blur(12px); background: var(--surface-glass)`).",
  ].join("\n");
}
