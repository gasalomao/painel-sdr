import { supabaseAdmin } from "@/lib/supabase_admin";

export interface WhatsAppExtractedInsights {
  linksAgendamento: string[];
  regrasPix: string[];
  diferenciaisServicos: string[];
  restricoesAtendimento: string[];
  mensagensIntegraisCliente: string[];
  rawSummary: string;
}

const SCHEDULING_DOMAINS = [
  "tuaagenda.com",
  "trinks.com",
  "calendly.com",
  "booksy.com",
  "avec.app",
  "avec.com",
  "agenda.link",
  "agendamento",
];

const PIX_PATTERNS = [
  /sinal(?:\s+de)?\s*(?:r\$|\d+%\s*|\d+\s*reais)/i,
  /(?:pagamento|dep[oó]sito)\s+antecipado/i,
  /taxa\s+de\s+reserva/i,
  /chave\s*pix/i,
  /pix\s+para\s+confirmar/i,
  /reserva\s+somente\s+com\s+pix/i,
  /50%\s*(?:no\s+ato|de\s+sinal|antecipado)/i,
];

const RESTRICTION_PATTERNS = [
  /(?:apenas|somente)\s+com\s+hora\s+marcada/i,
  /atendimento\s+exclusivo/i,
  /n[ãa]o\s+atendemos\s+sem\s+agendar/i,
  /apenas\s+(?:mulheres|feminino)/i,
  /toler[âa]ncia\s+de\s+\d+\s+minutos/i,
];

/**
 * Minera conversas do WhatsApp do lead para extrair particularidades operacionais
 * (links de agendamento externos, exigência de sinal/PIX, regras de atendimento).
 */
export async function extractWhatsAppConversationContext(
  remoteJid: string,
  clientId: string,
  supabase = supabaseAdmin
): Promise<WhatsAppExtractedInsights> {
  const result: WhatsAppExtractedInsights = {
    linksAgendamento: [],
    regrasPix: [],
    diferenciaisServicos: [],
    restricoesAtendimento: [],
    mensagensIntegraisCliente: [],
    rawSummary: "",
  };

  if (!remoteJid || !clientId || !supabase) {
    return result;
  }

  try {
    // 1. Busca mensagens trocadas no chats_dashboard
    const { data: chats } = await supabase
      .from("chats_dashboard")
      .select("sender_type, content, created_at")
      .eq("remote_jid", remoteJid)
      .eq("client_id", clientId)
      .order("created_at", { ascending: true })
      .limit(100);

    const messages = chats || [];
    const textPool: string[] = [];
    const clientMsgs: string[] = [];

    for (const msg of messages) {
      if (typeof msg.content === "string" && msg.content.trim()) {
        const trimmed = msg.content.trim();
        textPool.push(trimmed);

        const sType = (msg.sender_type || "").toLowerCase();
        const isClient =
          sType === "customer" ||
          sType === "client" ||
          sType === "lead" ||
          (!["ai", "bot", "assistant", "system", "human", "agent"].includes(sType));

        if (isClient) {
          clientMsgs.push(trimmed);
        }
      }
    }

    result.mensagensIntegraisCliente = clientMsgs;

    if (textPool.length === 0) {
      return result;
    }

    const uniqueLinks = new Set<string>();
    const uniquePix = new Set<string>();
    const uniqueRestrictions = new Set<string>();
    const uniqueServices = new Set<string>();

    for (const text of textPool) {
      // Extração de URLs
      const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      for (const url of urlMatches) {
        const lower = url.toLowerCase();
        if (SCHEDULING_DOMAINS.some((d) => lower.includes(d))) {
          uniqueLinks.add(url);
        }
      }

      // Sentenças individuais
      const sentences = text.split(/[.\n!?]+/).map((s) => s.trim()).filter(Boolean);

      for (const sentence of sentences) {
        // Regras de PIX / Sinal
        if (PIX_PATTERNS.some((pattern) => pattern.test(sentence))) {
          uniquePix.add(sentence);
        }

        // Restrições de atendimento
        if (RESTRICTION_PATTERNS.some((pattern) => pattern.test(sentence))) {
          uniqueRestrictions.add(sentence);
        }

        // Destaques de serviços
        if (/trabalhamos\s+com|especialistas?\s+em|nossos?\s+servi[çc]os?|temos\s+tamb[ée]m/i.test(sentence)) {
          uniqueServices.add(sentence);
        }
      }
    }

    result.linksAgendamento = Array.from(uniqueLinks);
    result.regrasPix = Array.from(uniquePix).slice(0, 5);
    result.restricoesAtendimento = Array.from(uniqueRestrictions).slice(0, 5);
    result.diferenciaisServicos = Array.from(uniqueServices).slice(0, 5);

    // Monta o resumo formatado
    const summaryLines: string[] = [];

    if (result.linksAgendamento.length > 0) {
      summaryLines.push(`Link(s) de Agendamento Externo: ${result.linksAgendamento.join(" | ")}`);
    }

    if (result.regrasPix.length > 0) {
      summaryLines.push(`Regras de Sinal / PIX: ${result.regrasPix.join(" ; ")}`);
    }

    if (result.restricoesAtendimento.length > 0) {
      summaryLines.push(`Restrições de Atendimento: ${result.restricoesAtendimento.join(" ; ")}`);
    }

    if (result.diferenciaisServicos.length > 0) {
      summaryLines.push(`Diferenciais e Serviços Mencionados: ${result.diferenciaisServicos.join(" ; ")}`);
    }

    if (result.mensagensIntegraisCliente.length > 0) {
      summaryLines.push("");
      summaryLines.push("MENSAGENS REAIS ENVIADAS PELO CLIENTE NO WHATSAPP (LEITURA OBRIGATÓRIA):");
      for (const m of result.mensagensIntegraisCliente) {
        summaryLines.push(`- "${m}"`);
      }
    }

    result.rawSummary = summaryLines.join("\n");
    return result;
  } catch (err: any) {
    console.warn("[whatsapp-context-extractor] Erro ao extrair contexto:", err?.message);
    return result;
  }
}
