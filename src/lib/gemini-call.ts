/**
 * Detector de "modelo morto" do Gemini. Detecta 404 "model no longer available"
 * e sinais relacionados nas mensagens de erro da API.
 *
 * Por quê: o endpoint `/v1beta/models` da Google fica DESATUALIZADO. Modelos
 * preview que foram despublicados ainda aparecem na lista, mas `generateContent`
 * retorna 404. A única fonte de verdade é a chamada real.
 */

export function isDeadModelError(err: any): boolean {
  const msg = String(err?.message || err || "");
  // Só conta como "modelo morto" se a mensagem cita o endpoint generateContent
  // ou explicitamente "no longer available". 404 de outras causas (auth, quota)
  // não deve disparar fallback.
  if (/no longer available/i.test(msg)) return true;
  if (/\b404\b/.test(msg) && /generateContent|models\//i.test(msg)) return true;
  return false;
}
