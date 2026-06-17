/**
 * Lista os modelos do "DeepSeek Chat" no formato OpenAI — isso é o que o
 * discovery do Gateway de Assinatura espera quando bate em `{baseUrl}/models`.
 * Como nosso proxy responde aqui, os modelos aparecem nos seletores
 * automaticamente sem mexer em mais nada.
 *
 * NÃO protegido por admin: o discovery server-side bate aqui via fetch, e a
 * lista de modelos NÃO contém segredo. O que é segredo (token) fica em disco.
 */

import { NextResponse } from "next/server";
import { DEEPSEEK_CHAT_MODELS } from "@/lib/deepseek-chat-client";
import { countActiveTokens } from "@/lib/deepseek-chat-manager";

export async function GET() {
  // Se não há token ativo, devolve lista vazia: assim o seletor não mostra um
  // grupo "DeepSeek Chat" sem nenhuma conta logada (UI mais limpa).
  if (countActiveTokens() === 0) {
    return NextResponse.json({ object: "list", data: [] });
  }
  return NextResponse.json({
    object: "list",
    data: DEEPSEEK_CHAT_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "deepseek",
      description: m.description,
    })),
  });
}
