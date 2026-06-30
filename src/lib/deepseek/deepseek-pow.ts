/**
 * Solver do Proof-of-Work (PoW) do chat.deepseek.com.
 *
 * POR QUE EXISTE: o DeepSeek passou a exigir que toda request a
 * `/api/v0/chat/completion` venha acompanhada de um header `x-ds-pow-response`
 * contendo a solução de um desafio SHA3 (DeepSeekHashV1) calculado num
 * WebAssembly. O navegador do usuário resolve isso sozinho; o nosso servidor
 * Node precisa replicar o cálculo, senão a request é silenciosamente descartada
 * (é exatamente isso que fazia o "DeepSeek não funciona" no painel).
 *
 * COMO FUNCIONA (fluxo):
 *   1. Antes de cada completion, pedimos um desafio em
 *      POST /api/v0/chat/create_pow_challenge {target_path:"/api/v0/chat/completion"}.
 *   2. O desafio vem com: algorithm, challenge, salt, difficulty, expire_at,
 *      signature, target_path.
 *   3. Montamos o prefixo `${salt}_${expire_at}_`, escrevemos challenge + prefix
 *      na memória do WASM e chamamos `wasm_solve`.
 *   4. O WASM faz um loop interno procurando um nonce cujo hash satisfaça a
 *      dificuldade — devolve a `answer` (inteiro) ou status 0 (sem solução).
 *   5. Empacotamos `{algorithm,challenge,salt,answer,signature,target_path}`
 *      em JSON e codificamos em base64 → esse é o valor do header.
 *
 * Referência da mecânica: github.com/xtekky/deepseek4free (dsk/pow.py) e
 * github.com/iidamie/deepseek2api (app.py, função compute_pow_answer).
 *
 * O binário WASM (`sha3_wasm_bg.7b9ca65ddd.wasm`, 26KB) é ZERO imports — roda
 * nativo no Node 22 via `WebAssembly.instantiate`, sem Python, sem pacote
 * novo, sem dependência nativa. Cacheamos a instância em memória pra não
 * recompilar a cada chamada (só o `wasm_solve` roda por request).
 *
 * Server-only.
 */

import { SHA3_WASM_BASE64 } from "./sha3-wasm-base64";

/** Campos do desafio PoW que o DeepSeek devolve em data.biz_data.challenge. */
export interface DsPowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}

/**
 * Resultado empacotado pronto pra virar o header `x-ds-pow-response`:
 * JSON compacto codificado em base64 (compatível com o que o navegador envia).
 * `null` quando o WASM não conseguiu resolver (desafio inválido/expirado).
 */
export type DsPowResponse = string | null;

// ---------------------------------------------------------------------------
// Instância WASM (singleton — compilar 1x, reutilizar em todas as chamadas).
// ---------------------------------------------------------------------------

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  /** Alocador wbindgen: (tamanho, alinhamento) → ptr. */
  __wbindgen_export_0: (len: number, align: number) => number;
  /** Ajusta o stack pointer wbindgen em N bytes (negativo = reserva). */
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  /** Loop de resolução: (retptr, ch_ptr, ch_len, prefix_ptr, prefix_len, difficulty). */
  wasm_solve: (
    retptr: number,
    chPtr: number,
    chLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ) => void;
}

let INSTANCE_CACHE: WebAssembly.Instance | null = null;
let INSTANCE_READY: Promise<WebAssembly.Instance> | null = null;

/** Decodifica o WASM em base64 e instancia (uma única vez por processo). */
async function getInstance(): Promise<WebAssembly.Instance> {
  if (INSTANCE_CACHE) return INSTANCE_CACHE;
  if (INSTANCE_READY) return INSTANCE_READY;
  INSTANCE_READY = (async () => {
    const bytes = Buffer.from(SHA3_WASM_BASE64, "base64");
    const { instance } = await WebAssembly.instantiate(bytes, {});
    INSTANCE_CACHE = instance;
    return instance;
  })();
  return INSTANCE_READY;
}

/**
 * Escreve uma string UTF-8 na memória do WASM usando o alocador wbindgen.
 * Devolve `{ ptr, len }`. IMPORTANTE: relê o buffer de memória DEPOIS de
 * alocar — `__wbindgen_export_0` pode crescer a memória (realocar o ArrayBuffer),
 * o que invalidaria qualquer referência anterior a `memory.buffer`.
 */
function writeString(exports: WasmExports, text: string): { ptr: number; len: number } {
  const enc = Buffer.from(text, "utf8");
  const len = enc.length;
  const ptr = exports.__wbindgen_export_0(len, 1);
  // Relê o buffer pós-alocação (pode ter mudado de endereço).
  new Uint8Array(exports.memory.buffer).set(enc, ptr);
  return { ptr, len };
}

/**
 * Resolve um desafio PoW do DeepSeek e devolve o valor do header
 * `x-ds-pow-response` (base64 do JSON), ou `null` se o WASM não achar solução
 * (desafio inválido/expirado — o chamador deve pedir um novo desafio e tentar
 * de novo). Espelha `compute_pow_answer` + `get_pow_response` da referência.
 */
export async function solvePowChallenge(c: DsPowChallenge): Promise<DsPowResponse> {
  // Algoritmo esperado pelo DeepSeek hoje. Se mudar, o servidor já nos avisa
  // no campo `algorithm` do desafio — aqui só validamos pra falhar cedo.
  if (c.algorithm && !/DeepSeekHashV1/i.test(c.algorithm)) {
    // Não bloqueia: pode ser um novo algoritmo compatível. Apenas loga.
    console.warn(`[deepseek-pow] Algoritmo inesperado: ${c.algorithm} (esperado DeepSeekHashV1).`);
  }

  const instance = await getInstance();
  const exports = instance.exports as unknown as WasmExports;

  // Prefixo no formato que o JS original do site monta: `${salt}_${expire_at}_`.
  const prefix = `${c.salt}_${c.expire_at}_`;

  // 1) Reserva 16 bytes no stack do wbindgen (4 de status + 4 pad + 8 de answer).
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    // 2) Escreve challenge e prefix na memória linear.
    const ch = writeString(exports, c.challenge);
    const px = writeString(exports, prefix);
    // 3) Roda o solver (loop interno procura nonce que satisfaz a dificuldade).
    exports.wasm_solve(retptr, ch.ptr, ch.len, px.ptr, px.len, c.difficulty);

    // 4) Lê status (i32 LE em retptr) e answer (f64 LE em retptr+8).
    // Relê o buffer aqui também: o loop pode ter alocado memória interna.
    const buf = Buffer.from(exports.memory.buffer);
    const status = buf.readInt32LE(retptr);
    if (status === 0) return null; // sem solução p/ este desafio
    const answer = Math.round(buf.readDoubleLE(retptr + 8));

    // 5) Empacota no shape que o header espera e codifica em base64.
    // Separadores compactos (sem espaços) — igual ao navegador.
    const payload = JSON.stringify({
      algorithm: c.algorithm,
      challenge: c.challenge,
      salt: c.salt,
      answer,
      signature: c.signature,
      target_path: c.target_path,
    });
    return Buffer.from(payload, "utf8").toString("base64");
  } finally {
    // 5) Sempre restaura o stack pointer, mesmo em erro.
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

/**
 * Resolve o desafio com N tentativas (cada uma pede um desafio novo via
 * `fetchChallenge`). Útil porque o WASM pode devolver status 0 pra um desafio
 * específico — pegando outro geralmente resolve. Devolve o header pronto ou
 * `null` se esgotarem as tentativas.
 *
 * `fetchChallenge` é injetado pra manter este módulo desacoplado do HTTP
 * (facilita testar o solver isoladamente).
 */
export async function solvePowWithRetry(
  fetchChallenge: () => Promise<DsPowChallenge | null>,
  maxAttempts = 3,
): Promise<DsPowResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const challenge = await fetchChallenge();
    if (!challenge) return null;
    try {
      const resp = await solvePowChallenge(challenge);
      if (resp) return resp;
    } catch (e) {
      console.warn(`[deepseek-pow] Tentativa ${i + 1} falhou:`, (e as Error)?.message);
    }
  }
  return null;
}
