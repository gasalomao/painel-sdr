import { cleanShortCompanyName } from "@/lib/lead-name-hygiene";

/**
 * Anexa apenas fatos objetivos sobre o estado da prévia no `<lead_context>` (Fase 1, em produção ou Fase 2),
 * deixando o roteiro e as frases sob controle total de `<core_instructions>` para manter paridade Sandbox vs Produção.
 */
export function appendSitePreviewContextLines(
  lines: string[],
  lead: Record<string, unknown>,
  agentConfig: Record<string, unknown> | null,
  sitePreviewAutoDetect: boolean,
): void {
  const previaStatus = typeof lead.previa_status === "string" ? lead.previa_status.trim() : "";
  const linkPrevia = typeof lead.link_previa === "string" ? lead.link_previa.trim() : "";
  const companyName =
    cleanShortCompanyName(typeof lead.nome_negocio === "string" ? lead.nome_negocio : "") ||
    "sua empresa";

  if (previaStatus) lines.push(`Status da Prévia de Site: ${previaStatus}`);
  if (linkPrevia) lines.push(`Link da Prévia: ${linkPrevia}`);

  const agentOpts = (agentConfig?.options || {}) as Record<string, unknown>;

  if (previaStatus === "PREVIA_PRONTA" && linkPrevia) {
    const pingEnviado = Boolean(lead.previa_ping_enviado_em);
    const confirmBeforeLink = Boolean(agentOpts.site_preview_confirm_before_link ?? true);

    lines.push("");
    lines.push("# 🎯 ESTADO DA PRÉVIA DE SITE (PRÉVIA PRONTA NO AR):");
    lines.push(`- Empresa: ${companyName}`);
    lines.push(`- Link oficial da prévia pronta: ${linkPrevia}`);
    lines.push(
      `- Política de envio: ${confirmBeforeLink ? "Confirmar disponibilidade antes de enviar o link" : "Envio direto do link permitido"}`,
    );

    if (confirmBeforeLink && !pingEnviado) {
      lines.push(
        "- Pergunta de disponibilidade já enviada: NÃO. Confirme primeiro se o cliente pode ver no celular agora (sem enviar o link neste turno).",
      );
    } else {
      lines.push(
        `- Envio do link liberado: compartilhe exatamente ${linkPrevia} usando o tom, a estrutura e as regras da Fase 2 definidas em <core_instructions>.`,
      );
    }
    lines.push(
      '- Agendamento: quando o cliente confirmar horário, acione a ferramenta de agenda definida em <core_instructions> (ou "agendar_reuniao_fechamento" se Google Calendar estiver desativado).',
    );
    lines.push(
      "- PRIORIDADE DE ROTEIRO: siga sempre as palavras, regras de preço, duração de reunião e política de domínio/contrato definidas em <core_instructions>.",
    );
    return;
  }

  if (previaStatus === "PREVIA_SOLICITADA") {
    lines.push("");
    lines.push("# 🎯 ESTADO DA PRÉVIA DE SITE: EM PRODUÇÃO.");
    lines.push(
      "- O cliente já aceitou a prévia e ela está sendo produzida (ainda sem link publicado). Siga <core_instructions> (sem repetir oferta nem inventar link).",
    );
    return;
  }

  if ((!previaStatus || previaStatus === "PREVIA_FALHOU" || previaStatus === "novo") && sitePreviewAutoDetect) {
    lines.push("");
    lines.push("# 🎯 ESTADO DA PRÉVIA DE SITE: AINDA NÃO SOLICITADA.");
    lines.push("- Ainda não há prévia gerada nem link publicado para este lead.");
    lines.push(
      '- Quando o cliente aceitar ver a prévia gratuita, chame a tool "solicitar_previa_site" e responda seguindo EXATAMENTE o roteiro, o prazo e as perguntas definidas em <core_instructions> (NÃO pule etapas nem use frases prontas fora de <core_instructions>).',
    );
  }
}
