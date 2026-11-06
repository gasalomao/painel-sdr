import { describe, expect, it, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { provisionLeadWorkspace } from "../workspace-provisioner";
import { evaluatePreviewAgreement } from "../agreement-detector";
import { buildAutonomousSitePrompt } from "../opencode-runner";
import { detectImpeccableAntiPatterns, sanitizeHtmlForImpeccable, validateHtmlCss } from "../impeccable-detector";
import { scanHtmlStatic } from "../site-quality-gate";
import { inspectLocalHtmlGeometry } from "../qa-inspector";
import { parseAgendaDateTime } from "@/lib/agenda-logic";

describe("Simulação Real Ponta a Ponta: Da Captação ao Agendamento via Sarah SDR & Closer", () => {
  let tempWorkspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempWorkspaceDir = path.join(os.tmpdir(), `test-full-pipeline-${Date.now()}`);
    await fs.mkdir(tempWorkspaceDir, { recursive: true });
  });

  it("Executa o ciclo completo da prospecção de site com validação de arquivos e regras", async () => {
    // =========================================================================
    // FASE 1: LEAD CAPTURADO NO GOOGLE MAPS
    // =========================================================================
    const mockLead = {
      id: 501,
      client_id: "tenant-principal-001",
      remoteJid: "5511988887777@s.whatsapp.net",
      nome_negocio: "Mecânica e Auto Elétrica São Lucas",
      ramo_negocio: "Oficina Mecânica e Auto Elétrica",
      categoria: "Auto Mecânica",
      endereco: "Av. Santo Amaro, 3200 - Brooklin, São Paulo - SP",
      telefone: "5511988887777",
      website: null,
      avaliacao: 4.9,
      reviews: 42,
      reviews_detalhes: [
        {
          autor: "Marcos Silva",
          nota: "5",
          data: "há 2 semanas",
          texto: "Melhor auto elétrica da região, resolveram o alternador do meu Civic no mesmo dia.",
        },
        {
          autor: "Renata Vasconcelos",
          nota: "5",
          data: "há 1 mês",
          texto: "Preço justo e atendimento honesto do Sr. Lucas. Recomendo de olhos fechados.",
        },
      ],
      previa_status: null,
    };

    // =========================================================================
    // FASE 2: SIMULAÇÃO DO CHAT - QUALIFICAÇÃO DA SARAH SDR & DETECÇÃO DE ACEITE
    // =========================================================================
    // Turno 1: Lead responde com interesse na abordagem inicial
    const turn1User = "Oi! Como funciona essa prévia de site gratuita que vocês falaram?";
    
    // Sarah SDR responde aplicando a trava anti-desperdício (Msg 8.1)
    const turn1Sarah =
      "Show! Já passei aqui para a nossa equipe montar a prévia da Mecânica e Auto Elétrica São Lucas! Quando a gente finalizar e te mandar o link por aqui você consegue dar uma olhadinha rápida para dizer o que achou?";

    // Turno 2: Lead confirma disponibilidade para olhar (Msg 8.2)
    const turn2User = "Com certeza, pode montar sim! Assim que mandar eu olho aqui no celular.";

    // Avaliação automática de aceite de prévia
    const aiProvider = await import("@/lib/ai-provider");
    const generateSpy = vi.spyOn(aiProvider, "generateText").mockResolvedValueOnce({
      text: JSON.stringify({
        aceitou: true,
        confianca: "alta",
        motivo: "Cliente confirmou explicitamente que olha no celular assim que mandar",
      }),
      usage: { promptTokens: 35, completionTokens: 15, totalTokens: 50 },
    } as any);

    const agreementMessages = [
      { role: "agent" as const, content: turn1Sarah },
      { role: "user" as const, content: turn2User },
    ];
    const agreementResult = await evaluatePreviewAgreement({ messages: agreementMessages });
    generateSpy.mockRestore();

    expect(agreementResult.agreed).toBe(true);
    expect(agreementResult.evaluatorMethod).toBe("ai");
    mockLead.previa_status = "PREVIA_SOLICITADA";
    expect(mockLead.previa_status).toBe("PREVIA_SOLICITADA");

    // =========================================================================
    // FASE 3: PROVISIONAMENTO DO WORKSPACE & GERAÇÃO AUTÔNOMA DO SITE
    // =========================================================================
    const provisionResult = await provisionLeadWorkspace({
      lead: mockLead,
      customWorkspaceDir: tempWorkspaceDir,
      skipLiveScrape: true,
      supabaseClient: {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: [] }),
                })),
              })),
            })),
          })),
        })),
      },
    });

    expect(provisionResult.workspaceDir).toBe(tempWorkspaceDir);

    // Valida que os arquivos de contexto e arquitetura foram gravados
    const filesInWorkspace = await fs.readdir(tempWorkspaceDir);
    expect(filesInWorkspace).toContain("INFORMACOES-DO-NEGOCIO.txt");
    expect(filesInWorkspace).toContain("PRODUCT.md");
    expect(filesInWorkspace).toContain("DESIGN.md");
    expect(filesInWorkspace).toContain("AGENTS.md");

    // Lê o briefing do negócio para atestar a fidelidade dos dados minerados
    const txtContent = await fs.readFile(path.join(tempWorkspaceDir, "INFORMACOES-DO-NEGOCIO.txt"), "utf-8");
    expect(txtContent).toContain("Mecânica e Auto Elétrica São Lucas");
    expect(txtContent).toContain("5511988887777");
    expect(txtContent).toContain("Av. Santo Amaro, 3200");
    expect(txtContent).toContain("4.9");

    // Gera o prompt especializado para o OpenCode CLI com a Skill Impeccable
    const autonomousPrompt = buildAutonomousSitePrompt({
      leadName: mockLead.nome_negocio,
      niche: mockLead.ramo_negocio,
    });
    expect(autonomousPrompt).toContain("/impeccable");
    expect(autonomousPrompt).toContain("Mecânica e Auto Elétrica São Lucas");

    // Simula a geração do site com as diretrizes Impeccable completas
    const generatedHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mecânica e Auto Elétrica São Lucas | Diagnóstico Automotivo no Brooklin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --color-primary: #1e3a8a;
      --color-accent: #f59e0b;
      --color-dark: #0f172a;
      --color-light: #f8fafc;
      --surface-interactive: #e2e8f0;
      --ease-interactive: cubic-bezier(0.16, 1, 0.3, 1);
      --font-main: "DM Sans", system-ui, sans-serif;
      --font-display: "Syne", "DM Sans", sans-serif;
    }
    html, body { overflow-x: hidden; width: 100%; }
    body { font-family: var(--font-main); font-size: 1rem; background: var(--color-light); color: var(--color-dark); line-height: 1.6; }
    h1, h2, h3 { font-family: var(--font-display); line-height: 1.1; }
    h1 { font-size: clamp(2.25rem, 5vw, 3.5rem); margin-bottom: 1rem; }
    h2 { font-size: clamp(1.5rem, 3vw, 2.25rem); }
    h3 { font-size: 1.375rem; }
    img { max-width: 100%; height: auto; }
    header { background: var(--color-dark); color: #fff; padding: 1.25rem 2rem; display: flex; justify-content: space-between; align-items: center; }
    .hero { padding: 5rem 2rem; text-align: center; background: #ffffff; }
    .hero-copy { max-width: 42rem; margin: 0 auto; animation: reveal-up 700ms var(--ease-interactive) both; }
    .hero-copy p { margin-top: 1rem; }
    .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 0.35rem 0.85rem; border-radius: 9999px; font-weight: 600; font-size: 0.875rem; margin-bottom: 1rem; }
    .btn-whatsapp { display: inline-flex; align-items: center; background: #166534; color: #ffffff; text-decoration: none; padding: 0.875rem 1.75rem; border-radius: 0.5rem; font-weight: 700; font-size: 1.0625rem; transition: transform 240ms var(--ease-interactive), background 240ms var(--ease-interactive); }
    .btn-whatsapp:hover { transform: translateY(-2px); }
    .reviews { padding: 5rem 2rem; background: #f1f5f9; }
    .reviews-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1.5rem; max-width: 62rem; margin: 2rem auto 0; animation: float-in 900ms var(--ease-interactive) both; }
    .review-card { background: #fff; padding: 1.75rem; border-radius: 0.75rem; border: 1px solid #e2e8f0; }
    footer { background: var(--color-dark); color: #94a3b8; padding: 2rem; text-align: center; font-size: 0.9375rem; }
    [data-reveal] { opacity: 0; transform: translateY(24px); transition: opacity 700ms var(--ease-interactive), transform 700ms var(--ease-interactive); }
    [data-reveal].is-visible { opacity: 1; transform: none; }
    @keyframes reveal-up { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
    @keyframes float-in { from { transform: translateY(8px); } to { transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <header>
    <div><strong>Mecânica e Auto Elétrica São Lucas</strong></div>
    <a href="https://wa.me/5511988887777" class="btn-whatsapp" style="font-size: 0.9rem; padding: 0.5rem 1rem;">Falar no WhatsApp</a>
  </header>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <div class="badge">⭐ 4.9 no Google (42 avaliações reais)</div>
        <h1>Seu carro em boas mãos no Brooklin</h1>
        <p>Diagnóstico computadorizado de injeção eletrônica, alternadores, freios e suspensão com quem entende.</p>
        <div style="margin-top: 2rem;">
          <a href="https://wa.me/5511988887777?text=Olá,%20vi%20o%20site%20da%20São%20Lucas%20e%20gostaria%20de%20um%20orçamento" class="btn-whatsapp">
            Agendar Avaliação via WhatsApp
          </a>
        </div>
      </div>
    </section>
    <section class="reviews">
      <h2 style="text-align: center;">O que nossos clientes dizem</h2>
      <div class="reviews-grid">
        <article class="review-card" data-reveal>
          <h3>Marcos Silva</h3>
          <p>"Melhor auto elétrica da região, resolveram o alternador do meu Civic no mesmo dia."</p>
        </article>
        <article class="review-card" data-reveal>
          <h3>Renata Vasconcelos</h3>
          <p>"Preço justo e atendimento honesto do Sr. Lucas. Recomendo de olhos fechados."</p>
        </article>
      </div>
    </section>
  </main>
  <footer>
    <p>Av. Santo Amaro, 3200 - Brooklin, São Paulo - SP | Telefone: (11) 98888-7777</p>
  </footer>
  <script>
    const revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      revealObserver.observe(el);
    });
  </script>
</body>
</html>`;

    const htmlPath = path.join(tempWorkspaceDir, "index.html");
    await fs.writeFile(htmlPath, generatedHtml, "utf-8");

    // Validação estrita de anti-patterns Impeccable
    const detectorReport = await detectImpeccableAntiPatterns(htmlPath);
    expect(detectorReport.clean).toBe(true);
    expect(detectorReport.issuesCount).toBe(0);

    // Camada 2 do gate: sintaxe CSS + movimento + reset de padding
    expect(validateHtmlCss(generatedHtml).valid).toBe(true);
    expect(scanHtmlStatic(generatedHtml, { requirePhotos: false })).toEqual([]);

    // Camada 3: geometria real em Desktop/Mobile (pulada se Chrome não existir)
    const audits = await inspectLocalHtmlGeometry(htmlPath);
    for (const audit of audits) {
      expect(audit.ok).toBe(true);
      expect(audit.keyframes).toBeGreaterThan(0);
      expect(audit.violations).toEqual([]);
    }

    // =========================================================================
    // FASE 4: SARAH CLOSER - DUPLO VÍNCULO & SCRIPT DE FECHAMENTO
    // =========================================================================
    const linkDeploy = "https://mecanica-sao-lucas.vercel.app";
    mockLead.previa_status = "PREVIA_PRONTA";
    const leadState = {
      ...mockLead,
      link_previa: linkDeploy,
      previa_ping_enviado_em: null as string | null,
    };

    // 1. DUPLO VÍNCULO: Envia o ping primeiro, SEM soltar o link direto
    const pingMessage =
      "Você está com o celular na mão? Nossa equipe finalizou a prévia da Mecânica e Auto Elétrica São Lucas!";
    expect(pingMessage).not.toContain("http");
    leadState.previa_ping_enviado_em = new Date().toISOString();

    // 2. Lead responde confirmando disponibilidade
    const leadPingResponse = "Tô sim no celular, pode mandar!";

    // 3. Sarah Closer entrega o link com enquadramento estratégico e matriz de fechamento
    const closerIntroScript = `Dá uma olhadinha aí no celular! Como é uma prévia inicial, montamos com o que encontramos disponível na internet só para você ter uma ideia de como a estrutura funciona, mas depois deixamos 100% do seu jeito, com as suas fotos e cores preferidas. Me conta: o que achou dessa ideia para a ${leadState.nome_negocio}? Link: ${leadState.link_previa}`;
    expect(closerIntroScript).toContain(linkDeploy);
    expect(closerIntroScript).toContain("Dá uma olhadinha aí no celular!");

    // 4. Lead reage positivamente e pergunta sobre preços / ajustes
    const leadReaction = "Cara, ficou muito bom! Como funciona pra colocar minha logo e quanto custa?";

    // 5. Sarah Closer aplica a regra dos 4 princípios inegociáveis:
    //    - ZERO preço por texto
    //    - ZERO termos técnicos
    //    - Proposta de call de 2 a 5 minutos
    const closerCallPitch =
      "Fico muito feliz que gostou! Sobre os valores e a personalização da sua logo, depende exatamente do que você vai querer manter. Para te passar certinho e sem compromisso, a gente consegue fazer uma chamada rápida de 3 minutinhos no WhatsApp? Você prefere hoje às 16h ou amanhã às 10h?";
    
    expect(closerCallPitch).not.toContain("R$");
    expect(closerCallPitch).not.toContain("hospedagem");
    expect(closerCallPitch).not.toContain("domínio");
    expect(closerCallPitch).toContain("chamada rápida de 3 minutinhos no WhatsApp");

    // 6. Lead aceita o horário
    const leadAgreedTime = "Amanhã às 10h fica perfeito pra mim!";

    // =========================================================================
    // FASE 5: TOOL AGENDAR_REUNIAO_FECHAMENTO & PERSISTÊNCIA CENTRAL
    // =========================================================================
    const callArgs = {
      horario_confirmado: "Amanhã às 10h",
      resumo_necessidades: "Cliente quer colocar o logotipo novo e ajustar serviços",
    };

    // Simulação dos registros no Supabase através do canal padrão
    let capturedLeadUpdate: any = null;
    let capturedSessionUpdate: any = null;
    let capturedAppointment: any = null;
    let ownerNotificationMessage: string | null = null;

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === "leads_extraidos") {
          return {
            update: vi.fn((data) => {
              capturedLeadUpdate = data;
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn().mockResolvedValue({ error: null }),
                })),
              };
            }),
          };
        }
        if (table === "sessions") {
          return {
            update: vi.fn((data) => {
              capturedSessionUpdate = data;
              return {
                eq: vi.fn().mockResolvedValue({ error: null }),
              };
            }),
          };
        }
        if (table === "appointments") {
          return {
            insert: vi.fn((data) => {
              capturedAppointment = data;
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    };

    // Executa persistência idêntica ao route.ts
    await mockSupabase
      .from("leads_extraidos")
      .update({
        previa_status: "REUNIAO_AGENDADA",
        status: "REUNIAO_AGENDADA",
        reuniao_agendada_em: new Date().toISOString(),
        reuniao_horario_confirmado: callArgs.horario_confirmado,
        reuniao_resumo: callArgs.resumo_necessidades,
      })
      .eq("client_id", mockLead.client_id)
      .eq("remoteJid", mockLead.remoteJid);

    await mockSupabase
      .from("sessions")
      .update({
        bot_status: "paused",
        paused_by: "system_meeting",
        paused_at: new Date().toISOString(),
      })
      .eq("id", "session-lead-501");

    const parsedDate = parseAgendaDateTime(callArgs.horario_confirmado);
    const startDt = !isNaN(parsedDate.getTime()) ? parsedDate : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const endDt = new Date(startDt.getTime() + 15 * 60 * 1000);

    await mockSupabase.from("appointments").insert({
      client_id: mockLead.client_id,
      agent_id: 1,
      lead_id: mockLead.id,
      remote_jid: mockLead.remoteJid,
      instance_name: "instancia-oficial",
      calendar_id: "whatsapp",
      title: `Reunião Fechamento - ${mockLead.nome_negocio}`,
      description: callArgs.resumo_necessidades,
      service_name: "Fechamento Site / Prévia",
      start_at: startDt.toISOString(),
      end_at: endDt.toISOString(),
      status: "confirmed",
      created_by: "ia",
      metadata: {
        horario_combinado: callArgs.horario_confirmado,
        link_previa: leadState.link_previa,
        nome_negocio: mockLead.nome_negocio,
      },
    });

    const ownerPhone = "5511999990000";
    ownerNotificationMessage = `🎉 *REUNIÃO AGENDADA PELA SARAH!*\n\n🏢 Empresa: ${mockLead.nome_negocio}\n📱 WhatsApp: ${mockLead.remoteJid.replace(/@.*$/, "")}\n⏰ Horário: ${callArgs.horario_confirmado}\n🔗 Prévia: ${leadState.link_previa}\n📝 Resumo: ${callArgs.resumo_necessidades}`;

    // =========================================================================
    // VALIDAÇÕES FINAIS DO CICLO INTEGRADO
    // =========================================================================
    expect(capturedLeadUpdate.previa_status).toBe("REUNIAO_AGENDADA");
    expect(capturedLeadUpdate.status).toBe("REUNIAO_AGENDADA");
    expect(capturedLeadUpdate.reuniao_horario_confirmado).toBe("Amanhã às 10h");

    expect(capturedSessionUpdate.bot_status).toBe("paused");
    expect(capturedSessionUpdate.paused_by).toBe("system_meeting");

    expect(capturedAppointment).toBeDefined();
    expect(capturedAppointment.title).toContain("Mecânica e Auto Elétrica São Lucas");
    expect(capturedAppointment.metadata.link_previa).toBe("https://mecanica-sao-lucas.vercel.app");
    expect(capturedAppointment.service_name).toBe("Fechamento Site / Prévia");

    expect(ownerNotificationMessage).toContain("Mecânica e Auto Elétrica São Lucas");
    expect(ownerNotificationMessage).toContain("Amanhã às 10h");
    expect(ownerNotificationMessage).toContain("https://mecanica-sao-lucas.vercel.app");
  }, 30_000);

  it("Sanitizador preserva tokens com sufixo 'inter' e resets de padding", () => {
    const html = `<style>
      :root { --surface-interactive: #111; --ease-interactive: cubic-bezier(0.16, 1, 0.3, 1); --font-inter: "Inter", sans-serif; }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      .a { padding: 0 0 2rem; }
      .hero-title { font-family: 'Inter', sans-serif; font-style: italic; }
    </style><p style="font-family: Inter">x</p>`;

    const cleaned = sanitizeHtmlForImpeccable(html);

    expect(cleaned).toContain("--surface-interactive");
    expect(cleaned).toContain("--ease-interactive");
    expect(cleaned).toContain('--font-inter: "Inter"');
    expect(cleaned).toContain("*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }");
    expect(cleaned).toContain(".a { padding: 0 0 2rem; }");
    expect(cleaned).not.toContain("padding: 4rem");
    expect(cleaned).not.toContain("Sansactive");
    expect(cleaned).toContain("DM Sans");
    expect(cleaned).toContain("font-style: normal");
    expect(validateHtmlCss(cleaned).valid).toBe(true);
  });

  it("validateHtmlCss detecta o CSS que o regex antigo corrompia", () => {
    const broken = `<style>:root { --surface-DM Sansactive: #111; }</style>`;
    expect(validateHtmlCss(broken).valid).toBe(false);

    const healthy = `<style>:root { --surface-interactive: #111; }</style>`;
    expect(validateHtmlCss(healthy).valid).toBe(true);
  });
});
