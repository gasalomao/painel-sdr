/**
 * Higiene determinística de nomes curtos de empresas e nomes humanos de sócios/decisores
 * para evitar que títulos de SEO do Google Maps ou termos de nicho/cidade poluam as abordagens da IA.
 */

const COMPOUND_HYPHEN_PREFIX_RE =
  /(?:ar|pr[ée]|p[óo]s|auto|anti|semi|micro|multi|mega|super|hiper|bem|sub|ex|ultra|extra|inter|intra|mini|macro|infra|retro|tele|video|v[íi]deo|cyber|bio|eco|geo|hidro|termo|eletro|m[ée]dico|odonto|socio|s[óo]cio|p[óo]s)$/i;

const PT_UF_CODES = new Set([
  "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg",
  "pa", "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to",
]);

const LOWERCASE_CONNECTORS = new Set(["de", "da", "do", "dos", "das", "e", "em", "no", "na", "para", "com", "&"]);

const KNOWN_LOCATIONS = [
  "franco da rocha",
  "taboao da serra",
  "sao bernardo do campo",
  "sao caetano do sul",
  "santo andre",
  "ribeirao preto",
  "sao jose dos campos",
  "sao jose do rio preto",
  "campos dos goytacazes",
  "duque de caxias",
  "juiz de fora",
  "feira de santana",
  "aguas claras",
  "belo horizonte",
  "porto alegre",
  "praia grande",
  "vila velha",
  "rio de janeiro",
  "sao paulo",
  "mogi das cruzes",
  "embu das artes",
  "santa barbara d'oeste",
  "guarulhos",
  "diadema",
  "osasco",
  "barueri",
  "maua",
  "cotia",
  "carapicuiba",
  "suzano",
  "itaquaquecetuba",
  "ferraz de vasconcelos",
  "poa",
  "cubatao",
  "santos",
  "guaruja",
  "bertioga",
  "campinas",
  "sorocaba",
  "jundiai",
  "piracicaba",
  "bauru",
  "marilia",
  "araraquara",
  "franca",
  "limeira",
  "americana",
  "indaiatuba",
  "atibaia",
  "braganca paulista",
  "taubate",
  "jacarei",
  "curitiba",
  "londrina",
  "maringa",
  "joinville",
  "blumenau",
  "florianopolis",
  "niteroi",
  "nova iguacu",
  "petropolis",
  "vitoria",
  "cariacica",
  "contagem",
  "betim",
  "uberlandia",
  "uberaba",
  "salvador",
  "fortaleza",
  "recife",
  "olinda",
  "jaboatao dos guararapes",
  "goiania",
  "anapolis",
  "aparecida de goiania",
  "brasilia",
  "taguatinga",
  "manaus",
  "belem",
  "canoas",
  "pelotas",
  "butanta",
  "vila sonia",
];

const SEO_PREFIX_RE =
  /^(?:instalador(?:a|es)?|instala[çc][aã]o|manuten[çc][aã]o|assist[êe]ncia\s+t[ée]cnica|conserto|higieniza[çc][aã]o|limpeza|servi[çc]os?|especialista\s+em|t[ée]cnico\s+em)\s+(?:de|do|da|em)\s+(?:ar[\s-]?condicionado(?:\s+automotivo)?|climatiza[çc][aã]o|refrigera[çc][aã]o|linha\s+branca|calhas|el[ée]trica)\s+/i;

const GENERIC_SEO_SEGMENT_RE =
  /^(?:ar[\s-]?condicionado(?:\s+automotivo)?|climatiza[çc][aã]o|refrigera[çc][aã]o|instalador(?:a)?|instala[çc][aã]o|manuten[çc][aã]o|higieniza[çc][aã]o|limpeza|servi[çc]os?\s+de|assist[êe]ncia\s+t[ée]cnica|clinica\s+odontol[óo]gica|consult[óo]rio\s+odontol[óo]gico|odontologia|est[ée]tica)/i;

const SECONDARY_SERVICE_CLAUSE_RE =
  /\s+(?:e|&)\s+(?:higieniza[çc][aã]o(?:\s+de\s+ar[\s-]?condicionado)?|instala[çc][õo]es\s+el[ée]tricas|el[ée]trica|radiadores|conforto|manuten[çc][aã]o|reparos?|acess[óo]rios)$/i;

export const NON_PERSON_NOISE_TOKENS = new Set([
  // Estabelecimentos e termos institucionais
  "clinica", "centro", "estetica", "saude", "odonto", "odontologia", "odontologico", "odontologica",
  "consultorio", "instituto", "studio", "espaco", "salao", "salon", "barbearia", "oficina", "pet",
  "vet", "veterinaria", "ltda", "eireli", "epp", "mei", "sa", "equipe", "atendimento",
  "recepcao", "direcao", "gerencia", "administracao", "admin", "owner", "proprietario",
  "responsavel", "dono", "dona", "paciente", "cliente", "implantes", "harmonizacao", "facial",
  "corporal", "avancada", "integrada", "medico", "medica", "dentista", "fisioterapia",
  "psicologia", "dermatologia", "unidade", "matriz", "filial", "oficial", "brasil",
  "dr", "dra", "prof", "beleza", "viva", "vida", "prime", "vip", "concept", "spa",
  "beauty", "care", "smile", "sorriso", "laser", "clean", "total", "center",
  // Nichos, serviços e termos comerciais
  "ar", "condicionado", "climatizacao", "refrigeracao", "eletrica", "eletrico", "eletricas",
  "automotivo", "automotiva", "radiadores", "radiador", "higienizacao", "instalacao",
  "instalacoes", "instalador", "instaladora", "manutencao", "limpeza", "servicos", "servico",
  "conforto", "gelo", "frio", "clima", "refriar", "familia", "pinguim", "proteses", "protese",
  "dente", "dentes", "emergencias", "emergencia", "mecanica", "mecanico", "auto", "pecas",
  "funilaria", "pintura", "vidracaria", "serralheria", "marcenaria", "padaria", "pizzaria",
  "restaurante", "lanchonete", "academia", "farmacia", "drogaria", "otica", "imobiliaria",
  "advocacia", "contabilidade", "construtora", "engenharia", "arquitetura", "assistencia",
  "tecnica", "tecnico", "solucoes", "solucao", "comercio", "distribuidora", "loja", "shop",
  "store", "house", "club", "group", "grupo", "rede", "express", "fast", "plus", "max", "pro",
  "tech", "digital", "sistemas", "consultoria", "assessoria", "terapia", "pilates", "nutricao",
  "ortodontia", "implantodontia", "radiologia", "laboratorio", "diagnostico", "hospital",
  "pronto", "socorro", "rudge", "minami", "alarco", "arken", "dearo", "ocean", "abcd",
  "climatizar", "gela", "vento", "arcondicionado", "conserto", "calhas",
  // Cidades, bairros e termos geográficos comuns
  "sao", "paulo", "curitiba", "belo", "horizonte", "rio", "janeiro", "brasilia", "porto",
  "alegre", "campinas", "santos", "goiania", "recife", "salvador", "fortaleza", "manaus",
  "praia", "grande", "rocha", "franco", "diadema", "guarulhos", "osasco", "taboao", "serra",
  "butanta", "sonia", "vila", "jardim", "parque", "centro", "zona", "norte", "sul", "leste",
  "oeste", "paulista", "abc", "santo", "andre", "bernardo", "caetano", "maua", "barueri",
  "cotia", "carapicuiba", "suzano", "mogi", "cruzes", "itaquaquecetuba", "ferraz", "poa",
  "cubatao", "guaruja", "bertioga", "sorocaba", "jundiai", "piracicaba", "ribeirao", "preto",
  "bauru", "marilia", "araraquara", "franca", "limeira", "americana", "indaiatuba", "atibaia",
  "braganca", "taubate", "jacarei", "niteroi", "duque", "caxias", "iguacu", "petropolis",
  "vitoria", "velha", "cariacica", "contagem", "betim", "uberlandia", "uberaba", "juiz",
  "fora", "londrina", "maringa", "joinville", "blumenau", "florianopolis", "canoas",
  "pelotas", "olinda", "jaboatao", "feira", "santana", "aparecida", "anapolis", "taguatinga",
  "aguas", "claras", "belem", "nova", "brasil", "sp", "rj", "mg", "es", "pr", "sc", "rs",
  "ba", "pe", "ce", "df", "go", "am", "pa",
]);

function normAsciiLower(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function splitNameSegments(raw: string): string[] {
  const parts: string[] = [];
  let start = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "|" || ch === "–" || ch === "—" || ch === "•" || ch === ":") {
      const seg = raw.slice(start, i).trim();
      if (seg) parts.push(seg);
      start = i + 1;
      continue;
    }

    if (ch === "-") {
      const prev = i > 0 ? raw[i - 1] : "";
      const next = i + 1 < raw.length ? raw[i + 1] : "";
      const hasSpaceBefore = prev === " ";
      const hasSpaceAfter = next === " ";
      if (hasSpaceBefore && hasSpaceAfter) {
        const seg = raw.slice(start, i).trim();
        if (seg) parts.push(seg);
        start = i + 1;
        continue;
      }
      if (hasSpaceBefore || hasSpaceAfter) {
        const leftPart = raw.slice(start, i).trim();
        const rightPart = raw.slice(i + 1).trim();
        const lastWordLeft = leftPart.split(/\s+/).pop() || "";
        const isCompound = COMPOUND_HYPHEN_PREFIX_RE.test(lastWordLeft);
        if (!isCompound && leftPart.length >= 2 && rightPart.length >= 2) {
          parts.push(leftPart);
          start = i + 1;
        }
      }
    }
  }

  const tail = raw.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function pickBestSegment(segments: string[]): string {
  if (segments.length <= 1) return segments[0] || "";
  const first = segments[0];
  const second = segments[1];

  if (/^(?:dr\.?|dra\.?)$/i.test(first)) {
    return `${first} ${second}`.trim();
  }

  const looksLikeSeoList =
    first.includes(",") ||
    (GENERIC_SEO_SEGMENT_RE.test(first) && first.split(/\s+/).length >= 4);

  if (looksLikeSeoList) {
    const brandSeg = segments.find(
      (seg, idx) => idx > 0 && !seg.includes(",") && !GENERIC_SEO_SEGMENT_RE.test(seg) && seg.length >= 3,
    );
    if (brandSeg) return brandSeg;
  }

  if (first.length <= 3 && !PT_UF_CODES.has(normAsciiLower(first))) {
    const nextWords = second.split(/\s+/).filter(Boolean);
    const firstSubstantive = nextWords.find(
      (w) => w.length >= 3 && !LOWERCASE_CONNECTORS.has(w.toLowerCase()),
    );
    return firstSubstantive ? `${first} ${firstSubstantive}` : `${first} ${second}`;
  }

  return first;
}

function stripLocationTail(raw: string, cidade?: string | null): string {
  let out = raw.trim();

  // Remove "/SP", "-SP", ", SP" no fim
  out = out
    .replace(/\s*[\/,\-]\s*(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i, "")
    .trim();

  // Remove " em Guarulhos", " em São Paulo", etc. no final quando houver marca antes
  const emLocMatch = out.match(/\s+(?:em|no|na)\s+([A-Za-zÀ-ÿ]+(?:\s+(?:da|de|do|dos|das)\s+[A-Za-zÀ-ÿ]+)?)$/i);
  if (emLocMatch && emLocMatch.index && emLocMatch.index >= 4) {
    out = out.slice(0, emLocMatch.index).trim();
  }

  const locCandidates = new Set<string>(KNOWN_LOCATIONS);
  const cityNorm = normAsciiLower(cidade || "");
  if (cityNorm.length >= 3) {
    locCandidates.add(cityNorm);
  }

  // Remove sufixo de cidade/bairro no fim (se mantiver marca válida com >= 2 palavras ou >= 6 chars)
  const words = out.split(/\s+/).filter(Boolean);
  for (let tailLen = Math.min(4, words.length - 1); tailLen >= 1; tailLen--) {
    const tailNorm = normAsciiLower(words.slice(-tailLen).join(" "));
    if (!locCandidates.has(tailNorm)) continue;
    const rem = words.slice(0, -tailLen);
    while (rem.length > 1 && /^(?:de|da|do|das|dos|em|no|na)$/i.test(rem[rem.length - 1])) {
      rem.pop();
    }
    const candidate = rem.join(" ").trim();
    if (rem.length >= 2 || candidate.length >= 6) {
      out = candidate;
      break;
    }
  }

  return out;
}

function normalizeCompanyCasing(raw: string): string {
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  const upperChars = (raw.match(/[A-ZÀ-Ú]/g) || []).length;
  const lowerChars = (raw.match(/[a-zà-ú]/g) || []).length;
  const isAllCaps = upperChars >= 4 && lowerChars === 0;

  if (!isAllCaps) {
    return words
      .map((word, idx) => {
        const lower = word.toLowerCase();
        if (idx > 0 && LOWERCASE_CONNECTORS.has(lower)) return lower;
        if (idx > 0 && /^[a-zà-ú]{2,}$/.test(word)) {
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        }
        return word;
      })
      .join(" ");
  }

  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && LOWERCASE_CONNECTORS.has(lower)) return lower;
      if (word.includes("&")) return word.toUpperCase();
      const lettersOnly = word.replace(/[^A-Za-zÀ-ÿ]/g, "");
      const hasVowel = /[aeiouáéíóúâêôãõà]/i.test(lettersOnly);
      if (word.includes("&")) return word.toUpperCase();
      if (idx === 0 && lettersOnly.length >= 2 && lettersOnly.length <= 4) {
        return word.toUpperCase();
      }
      if (lettersOnly.length >= 2 && lettersOnly.length <= 4 && !hasVowel) {
        return word.toUpperCase();
      }
      if (lower === "ocean" && word === "OCEAN") return "OCEAN";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * Normaliza e encurta nomes comerciais vindos do Google Maps para uso natural em mensagens.
 */
export function cleanShortCompanyName(
  rawName: string | null | undefined,
  cidade?: string | null,
): string {
  const withoutParens = String(rawName || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutParens) return "";

  const segments = splitNameSegments(withoutParens);
  let core = pickBestSegment(segments);

  // Remove prefixos SEO ("Instalador de ar condicionado Diego luz em Guarulhos" -> "Diego luz em Guarulhos")
  const withoutSeoPrefix = core.replace(SEO_PREFIX_RE, "").trim();
  if (withoutSeoPrefix.length >= 3) {
    core = withoutSeoPrefix;
  }

  // Remove sufixos societários comuns em razão social (LTDA, EIRELI, EPP, MEI, S/A, S.A., ME no fim)
  core = core
    .replace(/(?:^|\s)(?:LTDA\.?|EIRELI|MEI|EPP|S\/A|S\.A\.|COM[ÉE]RCIO(?:\s+DE)?|SERVI[ÇC]OS(?:\s+DE)?)(?=$|[\s,.\-])/gi, " ")
    .replace(/\bME\s*$/i, "")
    .replace(/\s+(?:II|III|IV|ll)$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  core = stripLocationTail(core, cidade);

  if (core.length > 26 || SECONDARY_SERVICE_CLAUSE_RE.test(core)) {
    const trimmedClause = core.replace(SECONDARY_SERVICE_CLAUSE_RE, "").trim();
    if (trimmedClause.length >= 4) {
      core = trimmedClause;
    }
  }

  if (core.length > 26) {
    const withoutAutomotivo = core.replace(/\s+(?:automotivo|automotiva)$/i, "").trim();
    if (withoutAutomotivo.length >= 5) {
      core = withoutAutomotivo;
    }
  }

  core = core.replace(/^[-–—,|:\s]+|[-–—,|:\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (!core) return withoutParens;

  return normalizeCompanyCasing(core);
}

const HONORIFIC_PREFIX_RE = /^\s*((?:dr\.?|dra\.?|prof\.?|arq\.?|adv\.?|eng\.?))\s+/i;
const PT_CONNECTORS_SET = new Set(["de", "da", "do", "dos", "das", "e"]);

function toTitleCaseName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && PT_CONNECTORS_SET.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export interface HumanNameSanitizeContext {
  businessName?: string | null;
  cidade?: string | null;
  bairro?: string | null;
  ramo?: string | null;
}

function matchesContextString(candidateNorm: string, ctxValue?: string | null): boolean {
  const targetNorm = normAsciiLower(ctxValue || "");
  if (!targetNorm || candidateNorm.length < 3) return false;
  if (candidateNorm === targetNorm) return true;
  if (targetNorm.split(" ").length >= 2 && targetNorm.includes(candidateNorm)) return true;
  return false;
}

/**
 * Verifica se uma string parece um nome próprio humano real (não termo de serviço, cidade ou marca).
 */
export function isPlausibleHumanPersonName(
  raw: string | null | undefined,
  ctx?: HumanNameSanitizeContext,
): boolean {
  const input = String(raw || "").replace(/\s+/g, " ").trim();
  if (!input || /\d/.test(input)) return false;

  const honorificMatch = input.match(HONORIFIC_PREFIX_RE);
  const hasHonorific = Boolean(honorificMatch);
  const body = input.replace(HONORIFIC_PREFIX_RE, "").trim();
  if (!body || /[^A-Za-zÀ-ÿ'\-\s]/.test(body)) return false;

  const words = body.split(/\s+/).filter(Boolean);
  const nonPrep = words.filter((w) => !PT_CONNECTORS_SET.has(w.toLowerCase()));
  if (nonPrep.length < 2 || nonPrep.length > 4) return false;

  for (const token of nonPrep) {
    const norm = normAsciiLower(token);
    if (norm.length < 2 || NON_PERSON_NOISE_TOKENS.has(norm)) return false;
  }

  const bodyNorm = normAsciiLower(body);
  if (ctx) {
    if (matchesContextString(bodyNorm, ctx.cidade) || matchesContextString(bodyNorm, ctx.bairro)) {
      return false;
    }
    if (matchesContextString(bodyNorm, ctx.ramo)) {
      return false;
    }
    if (!hasHonorific && ctx.businessName) {
      const bizNorm = normAsciiLower(ctx.businessName);
      if (bizNorm === bodyNorm) return false;
      const shortNorm = normAsciiLower(cleanShortCompanyName(ctx.businessName, ctx.cidade));
      if (shortNorm && (shortNorm === bodyNorm || bodyNorm === shortNorm)) return false;
    }
  }

  return true;
}

/**
 * Retorna nome humano sanitizado (preservando `Dr.`/`Dra.` se presente), ou `""` quando for ruído.
 */
export function sanitizeHumanPersonName(
  raw: string | null | undefined,
  ctx?: HumanNameSanitizeContext,
): string {
  const input = String(raw || "").replace(/\s+/g, " ").trim();
  if (!isPlausibleHumanPersonName(input, ctx)) return "";

  const honorificMatch = input.match(HONORIFIC_PREFIX_RE);
  const body = input.replace(HONORIFIC_PREFIX_RE, "").trim();
  const formattedBody = toTitleCaseName(body);

  if (honorificMatch) {
    const rawPrefix = honorificMatch[1].replace(/\.$/, "");
    const titlePrefix = rawPrefix.charAt(0).toUpperCase() + rawPrefix.slice(1).toLowerCase() + ".";
    return `${titlePrefix} ${formattedBody}`;
  }

  return formattedBody;
}

/**
 * Sanitiza primeiro nome de sócio (aceita 1 palavra se não estiver na blacklist nem no contexto geográfico/nicho).
 */
export function sanitizeHumanFirstName(
  raw: string | null | undefined,
  ctx?: HumanNameSanitizeContext,
): string {
  const input = String(raw || "").replace(HONORIFIC_PREFIX_RE, "").replace(/\s+/g, " ").trim();
  if (!input || /\d/.test(input)) return "";
  const firstWord = input.split(/\s+/)[0] || "";
  if (firstWord.length < 2 || /[^A-Za-zÀ-ÿ'\-]/.test(firstWord)) return "";

  const norm = normAsciiLower(firstWord);
  if (NON_PERSON_NOISE_TOKENS.has(norm)) return "";
  if (ctx) {
    if (matchesContextString(norm, ctx.cidade) || matchesContextString(norm, ctx.bairro) || matchesContextString(norm, ctx.ramo)) {
      return "";
    }
    if (ctx.businessName) {
      const fullWords = input.split(/\s+/).filter(Boolean);
      if (fullWords.length >= 2 && !isPlausibleHumanPersonName(input, ctx)) {
        return "";
      }
      const shortWords = normAsciiLower(cleanShortCompanyName(ctx.businessName, ctx.cidade)).split(" ");
      if (shortWords.length === 1 && shortWords[0] === norm) return "";
    }
  }

  return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
}
