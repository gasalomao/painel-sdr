/**
 * Helpers isomórficos leves para normalização de telefone BR, CNPJ e e-mail comercial.
 * Compartilhados entre componentes client-side do CRM e serviços server-side do extrator
 * sem puxar módulos de rede/busca para o bundle do navegador.
 */

const JUNK_EMAIL_NOISE_RE =
  /^(?:noreply|no-reply|donotreply|suporte@wix|sentry|user@domain|email@exemplo|teste@|contato@seudominio|example@)/i;
const JUNK_EMAIL_HOST_RE =
  /(?:sentry\.io|wixpress\.com|example\.com|yourdomain\.com|googleapis\.com|w3\.org|schema\.org|cloudflare\.com|wordpress\.org|gravatar\.com)$/i;

export function isValidBusinessEmail(rawEmail: string): boolean {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!email || email.length > 160) return false;
  if (!/^[a-z0-9._%+-]{2,64}@[a-z0-9.-]+\.[a-z]{2,12}$/.test(email)) return false;
  if (/\.(?:png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(email)) return false;
  if (JUNK_EMAIL_NOISE_RE.test(email)) return false;
  const host = email.split("@")[1] || "";
  if (JUNK_EMAIL_HOST_RE.test(host)) return false;
  return true;
}

/**
 * Normaliza telefone BR para dígitos com DDI 55 quando aplicável (10 ou 11 dígitos locais).
 */
export function normalizeBrPhoneDigits(raw: string): string {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0") && digits.length >= 11 && digits.length <= 12) {
    digits = digits.slice(1);
  }
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  return "";
}

export function isBrMobileDigits(digitsWithDdi: string): boolean {
  const clean = normalizeBrPhoneDigits(digitsWithDdi);
  if (clean.length === 13 && clean.startsWith("55")) {
    return clean[4] === "9";
  }
  return false;
}

/**
 * Identifica celulares cadastrados na Receita Federal ainda no formato antigo de 8 dígitos
 * (regra Anatel: prefixo 6, 7, 8 ou 9 é SMP móvel; 2..5 é fixo STFC).
 */
export function isAnatel8DigitMobile(digitsWithDdi: string): boolean {
  const clean = normalizeBrPhoneDigits(digitsWithDdi);
  return clean.length === 12 && clean.startsWith("55") && /^[6789]/.test(clean.slice(4));
}

/**
 * Reconstrói o 9º dígito para celulares de 8 dígitos vindos da Receita Federal.
 */
export function toModern13DigitBrMobile(digitsWithDdi: string): string {
  const clean = normalizeBrPhoneDigits(digitsWithDdi);
  if (!clean) return "";
  if (isAnatel8DigitMobile(clean)) {
    return `${clean.slice(0, 4)}9${clean.slice(4)}`;
  }
  return clean;
}

export function isEffectiveBrMobile(digitsWithDdi: string): boolean {
  return isBrMobileDigits(digitsWithDdi) || isAnatel8DigitMobile(digitsWithDdi);
}

/**
 * Gera variantes para consulta na Evolution API sem multiplicar chamadas para números já em 13 dígitos.
 */
export function expandBrPhoneCheckVariants(digitsWithDdi: string): string[] {
  const clean = normalizeBrPhoneDigits(digitsWithDdi);
  if (!clean) return [];
  if (isAnatel8DigitMobile(clean)) {
    return [toModern13DigitBrMobile(clean), clean];
  }
  return [clean];
}

/**
 * Valida CNPJ brasileiro com o algoritmo oficial Módulo-11 (2 dígitos verificadores).
 */
export function isValidCnpj(raw: string): boolean {
  const cnpj = String(raw || "").replace(/\D/g, "");
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const calcDigit = (sliceLen: number): number => {
    let weight = sliceLen - 7;
    let sum = 0;
    for (let i = 0; i < sliceLen; i++) {
      sum += Number(cnpj[i]) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const d1 = calcDigit(12);
  const d2 = calcDigit(13);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

export function formatCnpj(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 14) return raw;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

