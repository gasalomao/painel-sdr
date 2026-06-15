// Backfill RAG: indexa TODOS os docs de agent_knowledge que ainda não têm
// chunks vetorizados. Idempotente — re-rodar é seguro (content_hash skipa
// docs já indexados).
//
// Uso: node scripts/backfill-rag.mjs [agent_id]
//   - sem arg: indexa todos os agentes
//   - com arg: só o agente passado
//
// Pré-requisitos:
//   1. Migration 006 aplicada (CREATE EXTENSION vector + tabela chunks)
//   2. .env.local com NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   3. ai_organizer_config.api_key (Gemini) preenchida

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";

// ---- ENV ----
try {
  const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {
  console.warn("Sem .env.local — usando env do shell.");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Faltam SUPABASE env."); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

// ---- CONFIG ----
const TARGET_AGENT = process.argv[2] ? Number(process.argv[2]) : null;
const CHUNK_CHARS = 2000;
const OVERLAP_CHARS = 200;
const EMBEDDING_MODEL = "gemini-embedding-001";

// ---- API KEY GEMINI ----
const { data: org } = await sb.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
const apiKey = org?.api_key;
if (!apiKey) { console.error("ai_organizer_config.api_key vazia. Configure em /configuracoes."); process.exit(1); }

const { GoogleGenerativeAI } = await import("@google/generative-ai");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

// ---- CHUNKER (espelho do lib/rag.ts) ----
function chunkText(text) {
  if (!text || !text.trim()) return [];
  const t = text.trim();
  if (t.length <= CHUNK_CHARS) return [t];
  const chunks = [];
  const paras = t.split(/\n\n+/).filter(Boolean);
  let cur = "";
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      if (cur) { chunks.push(cur.trim()); cur = ""; }
      // split por sentença
      const sents = p.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
      let c2 = "";
      for (const s of sents) {
        if (s.length > CHUNK_CHARS) {
          if (c2) { chunks.push(c2.trim()); c2 = ""; }
          // hard split
          for (let i = 0; i < s.length; i += CHUNK_CHARS - OVERLAP_CHARS) {
            chunks.push(s.slice(i, i + CHUNK_CHARS));
          }
        } else if ((c2 + " " + s).length <= CHUNK_CHARS) {
          c2 = c2 ? c2 + " " + s : s;
        } else {
          if (c2) chunks.push(c2.trim());
          c2 = s;
        }
      }
      if (c2) chunks.push(c2.trim());
    } else if ((cur + "\n\n" + p).length <= CHUNK_CHARS) {
      cur = cur ? cur + "\n\n" + p : p;
    } else {
      if (cur) chunks.push(cur.trim());
      cur = p;
    }
  }
  if (cur) chunks.push(cur.trim());
  // overlap entre chunks
  if (chunks.length <= 1) return chunks;
  const out = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const ov = chunks[i - 1].slice(-OVERLAP_CHARS);
    out.push(ov + "\n\n" + chunks[i]);
  }
  return out;
}

async function embedBatch(texts) {
  const BATCH = 100;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const res = await model.batchEmbedContents({
      requests: slice.map((t) => ({
        content: { role: "user", parts: [{ text: t }] },
        taskType: "RETRIEVAL_DOCUMENT",
      })),
    });
    for (const e of res.embeddings) {
      if (!e.values || e.values.length !== 768) {
        throw new Error(`Dim errada: esperado 768, veio ${e.values?.length}`);
      }
      out.push(e.values);
    }
  }
  return out;
}

// ---- PIPELINE ----
let docsQuery = sb.from("agent_knowledge").select("id, agent_id, title, content");
if (TARGET_AGENT) docsQuery = docsQuery.eq("agent_id", TARGET_AGENT);
const { data: docs, error: docsErr } = await docsQuery;
if (docsErr) { console.error("Erro lendo docs:", docsErr.message); process.exit(1); }

console.log(`Processando ${docs.length} doc(s)${TARGET_AGENT ? ` do agent ${TARGET_AGENT}` : ""}...\n`);

let stats = { ok: 0, skip: 0, fail: 0, chunks: 0 };

for (const doc of docs) {
  process.stdout.write(`[${doc.id.slice(0, 8)}] ${doc.title?.slice(0, 50) || "(sem título)"} ... `);

  const fullText = `${doc.title || ""}\n\n${doc.content || ""}`.trim();
  if (!fullText) { console.log("VAZIO, skip"); stats.skip++; continue; }

  const hash = crypto.createHash("sha256").update(fullText).digest("hex").slice(0, 16);

  // Skip se já indexado com hash atual
  const { data: existing } = await sb
    .from("agent_knowledge_chunks")
    .select("content_hash")
    .eq("knowledge_id", doc.id)
    .limit(1);
  if (existing?.length > 0 && existing[0].content_hash === hash) {
    console.log("já indexado, skip");
    stats.skip++;
    continue;
  }

  try {
    // Pega client_id do agente
    const { data: agent } = await sb.from("agent_settings").select("client_id").eq("id", doc.agent_id).maybeSingle();

    const chunks = chunkText(fullText);
    const embeddings = await embedBatch(chunks);

    await sb.from("agent_knowledge_chunks").delete().eq("knowledge_id", doc.id);

    const rows = chunks.map((c, i) => ({
      knowledge_id: doc.id,
      agent_id: doc.agent_id,
      client_id: agent?.client_id || null,
      chunk_index: i,
      content: c,
      embedding: embeddings[i],
      token_count: Math.ceil(c.length / 4),
      content_hash: hash,
    }));
    for (let i = 0; i < rows.length; i += 50) {
      const { error: insErr } = await sb.from("agent_knowledge_chunks").insert(rows.slice(i, i + 50));
      if (insErr) throw insErr;
    }
    console.log(`${chunks.length} chunks ✓`);
    stats.ok++;
    stats.chunks += chunks.length;
  } catch (e) {
    console.log(`FALHA: ${e.message}`);
    stats.fail++;
  }
}

console.log(`\n=== Resumo ===`);
console.log(`Indexados: ${stats.ok} (${stats.chunks} chunks)`);
console.log(`Skipados:  ${stats.skip}`);
console.log(`Falhas:    ${stats.fail}`);
process.exit(stats.fail > 0 ? 1 : 0);
