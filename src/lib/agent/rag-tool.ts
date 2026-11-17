import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { indexKnowledgeDocument, searchKnowledge } from "@/lib/rag";
import { invalidateAgentConfigCache } from "@/lib/agent-config-cache";

export interface CallLogEntry {
  role: string;
  content: string;
}

/**
 * Executa busca semântica RAG na base de conhecimento do agente com fallback ILIKE
 * para documentos recém-cadastrados, populando `onValidText` para whitelist de imagens.
 */
export async function executeSearchKnowledgeBase(params: {
  query: unknown;
  agentId: number;
  clientId: string;
  apiKey: string | null;
  onValidText: (text: string) => void;
  callLogs: CallLogEntry[];
}): Promise<Record<string, unknown>> {
  const { query, agentId, clientId, apiKey, onValidText, callLogs } = params;
  const raw = (
    typeof query === "string"
      ? query
      : ((query as { text?: string } | null)?.text || JSON.stringify(query || ""))
  )
    .trim()
    .slice(0, 500);

  let matches: Array<{ title: string; content: string; similarity: number | null }> = [];
  let searchMethod = "none";
  let dbgError: string | null = null;

  if (raw) {
    try {
      const listIntent = /\b(todos|todas|quais?|lista|listar|cat[aá]logo|modelos?|op[cç][oõ]es?|varia[a-z]+|vers[oõ]es?)\b/i.test(raw);
      const topK = listIntent ? 15 : 10;
      const hits = await searchKnowledge({
        query: raw,
        agentId,
        clientId,
        apiKey: apiKey || "",
        topK,
        minSimilarity: 0.35,
      });
      if (hits.length > 0) {
        matches = hits.map((h) => ({
          title: h.title,
          content: h.content,
          similarity: h.similarity,
        }));
        searchMethod = "vector";
      }
    } catch (e: unknown) {
      dbgError = e instanceof Error ? e.message : String(e);
      console.warn("[RAG] vector search falhou, caindo no ILIKE:", dbgError);
    }
  }

  if (matches.length === 0 && raw && supabase) {
    const safeQuery = raw.toLowerCase().replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim();
    if (safeQuery) {
      const titleHit = await supabase
        .from("agent_knowledge")
        .select("id, title, content")
        .eq("agent_id", agentId)
        .or(`client_id.eq.${clientId},client_id.is.null`)
        .ilike("title", `%${safeQuery}%`)
        .limit(3);

      let docs = (titleHit.data || []) as Array<{ id: string; title: string; content: string }>;
      if (docs.length === 0) {
        const contentHit = await supabase
          .from("agent_knowledge")
          .select("id, title, content")
          .eq("agent_id", agentId)
          .or(`client_id.eq.${clientId},client_id.is.null`)
          .ilike("content", `%${safeQuery}%`)
          .limit(3);
        docs = (contentHit.data || []) as Array<{ id: string; title: string; content: string }>;
      }
      if (docs.length > 0) {
        const MAX = 1800;
        matches = docs.map((k) => ({
          title: k.title,
          content:
            (k.content || "").length > MAX
              ? (k.content || "").slice(0, MAX) + `\n[...truncado, doc tem ${(k.content || "").length} chars]`
              : k.content || "",
          similarity: null,
        }));
        searchMethod = "ilike-fallback";
      }
    }
  }

  callLogs.push({ role: "system", content: `[RAG] "${raw}" | method=${searchMethod} | hits=${matches.length}` });

  if (matches.length > 0) {
    for (const m of matches) onValidText(String(m.content || ""));
    return {
      found: true,
      method: searchMethod,
      documents: matches.map((m) =>
        m.similarity != null
          ? `[${m.title} | relevância ${(m.similarity * 100).toFixed(0)}%]\n${m.content}`
          : `[${m.title}]\n${m.content}`,
      ),
    };
  }

  return {
    found: false,
    message: `Nada na base corresponde a "${raw}". Diga ao cliente que vai verificar e voltar — NÃO INVENTE resposta.`,
    ...(dbgError ? { _debug_error: dbgError } : {}),
  };
}

/**
 * Atualiza estoque de produto na base de conhecimento após venda confirmada (suprimido em testMode).
 */
export async function executeUpdateProductStock(params: {
  productName: unknown;
  quantitySold: unknown;
  agentId: number;
  clientId: string;
  apiKey: string | null;
  isTestMode: boolean;
  callLogs: CallLogEntry[];
}): Promise<Record<string, unknown>> {
  const { productName, quantitySold, agentId, clientId, apiKey, isTestMode, callLogs } = params;

  if (isTestMode) {
    callLogs.push({ role: "system", content: "[TESTE] update_product_stock suprimido" });
    return { simulated: true, message: "Modo teste: alteração de estoque suprimida." };
  }

  const rawProd = String(productName || "").trim();
  const qtySold = Number(quantitySold) || 1;
  if (rawProd && supabase) {
    const likeTerm = rawProd.replace(/[%_,()"]/g, " ").trim();
    if (likeTerm) {
      const { data: docs } = await supabase
        .from("agent_knowledge")
        .select("id, title, content, client_id")
        .eq("agent_id", agentId)
        .or(`title.ilike.%${likeTerm}%,content.ilike.%${likeTerm}%`)
        .limit(20);

      for (const d of (docs || []) as Array<{ id: string; title?: string; content?: string; client_id?: string | null }>) {
        if (d.client_id && d.client_id !== clientId) continue;
        if (!d.content) continue;
        const cleanName = rawProd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const stockRegex = new RegExp(`(${cleanName}[\\s\\S]*?Estoque(?:\\s*Disponível)?:\\s*)(\\d+)`, "i");
        const genericRegex = new RegExp("(Estoque(?:\\s*Disponível)?:\\s*)(\\d+)", "i");
        const match =
          d.content.match(stockRegex) ||
          (d.content.toLowerCase().includes(rawProd.toLowerCase()) ? d.content.match(genericRegex) : null);

        if (match) {
          const currentQty = parseInt(match[2], 10);
          const newQty = Math.max(0, currentQty - qtySold);
          const updatedContent = d.content.replace(match[0], `${match[1]}${newQty}`);

          await supabase
            .from("agent_knowledge")
            .update({ content: updatedContent })
            .eq("id", d.id)
            .eq("agent_id", agentId);
          invalidateAgentConfigCache(agentId);

          indexKnowledgeDocument({
            knowledgeId: d.id,
            agentId,
            clientId: d.client_id || clientId,
            title: d.title || "",
            content: updatedContent,
            apiKey: apiKey || "",
          }).catch(() => {});

          callLogs.push({ role: "system", content: `[Estoque Atualizado] "${rawProd}" (${currentQty} -> ${newQty})` });
          return {
            success: true,
            product: rawProd,
            previousStock: currentQty,
            newStock: newQty,
            message: `Estoque do item "${rawProd}" atualizado de ${currentQty} para ${newQty} unidades disponíveis.`,
          };
        }
      }
    }
  }

  callLogs.push({ role: "system", content: `[Estoque Erro] Item "${rawProd}" não encontrado` });
  return {
    success: false,
    message: `Item "${rawProd}" não encontrado para atualizar estoque.`,
  };
}

