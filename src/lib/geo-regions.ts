/**
 * Expansão offline por municípios e coordenadas de referência da base local.
 * Resolve somente nomes exatos (ou aliases explícitos), sem inferir capital por UF.
 * Distância em linha reta entre as referências municipais, não distância por estrada
 * nem prova de contiguidade. A origem solicitada permanece fixa entre os lotes.
 */
import municipalitiesData from "./data/brazil-municipalities.json";

export const BRAZIL_UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO"
] as const;

export const UF_REGEX = new RegExp(`\\b(${BRAZIL_UFS.join("|")})\\b`, "i");

export const LOGRADOURO_PREFIX = /^(?:·\s*|[-–—]\s*)?(?:r\.|rua\b|av\.?\b|avenida\b|al\.|alameda\b|tr\.|travessa\b|pra[çc]a\b|pc\.|rod\.?\b|rodovia\b|estrada\b|est\.?\b|largo\b|quadra\b|qd\.|bloco\b|conjunto\b|lote\b|via\b|trav\.|beco\b|estradinha\b|passagem\b)/i;

function normalizeKey(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-–—/,\.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mesma normalização textual usada pelo engine; a identidade municipal inclui UF. */
export function normRegionName(str: string): string {
  return normalizeKey(str);
}

const STATE_NAMES: Record<string, string> = Object.assign(Object.create(null), {
  "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM",
  "bahia": "BA", "ceara": "CE", "distrito federal": "DF", "espirito santo": "ES",
  "goias": "GO", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
  "minas gerais": "MG", "para": "PA", "paraiba": "PB", "parana": "PR",
  "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ", "rio grande do norte": "RN",
  "rio grande do sul": "RS", "rondonia": "RO", "roraima": "RR", "santa catarina": "SC",
  "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO",
});
export const STATE_CAPITALS: Record<string, string> = Object.assign(Object.create(null), {
  AC: "Rio Branco", AL: "Maceió", AP: "Macapá", AM: "Manaus",
  BA: "Salvador", CE: "Fortaleza", DF: "Brasília", ES: "Vitória",
  GO: "Goiânia", MA: "São Luís", MT: "Cuiabá", MS: "Campo Grande",
  MG: "Belo Horizonte", PA: "Belém", PB: "João Pessoa", PR: "Curitiba",
  PE: "Recife", PI: "Teresina", RJ: "Rio de Janeiro", RN: "Natal",
  RS: "Porto Alegre", RO: "Porto Velho", RR: "Boa Vista", SC: "Florianópolis",
  SP: "São Paulo", SE: "Aracaju", TO: "Palmas",
});
const STATE_SUFFIX = new RegExp(`^(.+) (${[
  ...Object.keys(STATE_NAMES), ...BRAZIL_UFS.map(uf => uf.toLowerCase()),
].sort((a, b) => b.length - a.length).join("|")})$`);

const CITY_ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  bh: "belo horizonte mg",
  sp: "sao paulo sp",
  rj: "rio de janeiro rj",
  df: "brasilia df",
});

type Municipality = readonly [name: string, uf: string, latitude: number, longitude: number];
const MUNICIPALITIES = municipalitiesData as unknown as readonly Municipality[];
const citiesByName = new Map<string, Municipality[]>();
const citiesByKey = new Map<string, Municipality>();
function cityKey(city: Municipality): string {
  return `${normalizeKey(city[0])} ${city[1].toLowerCase()}`;
}
for (const city of MUNICIPALITIES) {
  const name = normalizeKey(city[0]);
  citiesByName.set(name, [...(citiesByName.get(name) ?? []), city]);
  citiesByKey.set(cityKey(city), city);
}

/** Nome inteiro, opcionalmente seguido de UF/sua forma por extenso. Sem fuzzy match. */
function resolveMunicipality(region: string): Municipality | null {
  const clean = normalizeKey(region);
  if (CITY_ALIASES[clean]) return citiesByKey.get(CITY_ALIASES[clean]) ?? null;
  const exact = citiesByName.get(clean);
  if (exact) {
    // "Espírito Santo" pode ser estado, não uma autorização para ir ao município RN.
    return exact.length === 1 && (!STATE_NAMES[clean] || STATE_NAMES[clean] === exact[0][1])
      ? exact[0] : null;
  }
  const suffix = clean.match(STATE_SUFFIX);
  if (!suffix) return null;
  const [, name, state] = suffix;
  const uf = STATE_NAMES[state] ?? state.toUpperCase();
  const alias = CITY_ALIASES[name] && citiesByKey.get(CITY_ALIASES[name]);
  if (alias) return alias[1] === uf ? alias : null;
  const matches = citiesByName.get(name)?.filter(city => city[1] === uf);
  return matches?.length === 1 ? matches[0] : null;
}

/** Extrai apenas UF explícito, inclusive estado por extenso; conflitos retornam null. */
export function extractUFFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = normalizeKey(text);
  const ufs = new Set([...text.normalize("NFC").matchAll(new RegExp(`(?:^|[^\\p{L}])(${BRAZIL_UFS.join("|")})(?=$|[^\\p{L}])`, "giu"))]
    .map(match => match[1].toUpperCase()));
  // Nome de município contendo estado não é indicação desse UF (Santa Bárbara do Pará).
  if (!citiesByName.has(clean) || STATE_NAMES[clean]) {
    const parts = text.split(/[,;/|]|\s[-–—]\s/).map(normalizeKey);
    for (let i = 0; i < parts.length; i++) {
      const state = STATE_NAMES[parts[i]];
      if (state && !(i === 0 && parts.length > 1 && citiesByName.has(parts[i]))) ufs.add(state);
    }
    const suffix = clean.match(STATE_SUFFIX);
    if (suffix && citiesByName.has(suffix[1])) ufs.add(STATE_NAMES[suffix[2]] ?? suffix[2].toUpperCase());
  }
  return ufs.size === 1 ? [...ufs][0] : null;
}

/** Inferência legada por prefixo de CEP. Não usada para resolver a origem da expansão. */
const CEP_RANGES: Array<[number, number, string]> = [
  [1, 19, "SP"], [20, 28, "RJ"], [29, 29, "ES"], [30, 39, "MG"],
  [40, 48, "BA"], [49, 49, "SE"], [50, 56, "PE"], [57, 57, "AL"],
  [58, 58, "PB"], [59, 59, "RN"], [60, 63, "CE"],
  [64, 65, "PI"], [66, 68, "MA"],
  [70, 72, "DF"], [73, 76, "GO"], [77, 77, "TO"],
  [78, 78, "MT"], [79, 79, "MS"],
  [80, 87, "PR"], [88, 89, "SC"], [90, 99, "RS"],
];
export function ufFromCep(cep: string | null | undefined): string | null {
  if (!cep) return null;
  const prefix = parseInt(String(cep).replace(/\D/g, "").slice(0, 2), 10);
  if (isNaN(prefix)) return null;
  if (prefix === 69) return null;
  for (const [lo, hi, uf] of CEP_RANGES) {
    if (prefix >= lo && prefix <= hi) return uf;
  }
  return null;
}

/** Validação de plausibilidade para o extrator; expansão exige município da base. */
export function isValidCityName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.replace(/^[·\s\-–—]+/, "").replace(/[·\s\-–—]+$/, "").trim();
  if (s.length < 3 || s.length > 50 || /\d/.test(s)) return false;
  if (citiesByName.has(normalizeKey(s))) return true;
  if (LOGRADOURO_PREFIX.test(s)) return false;
  if (new RegExp(`^(?:${BRAZIL_UFS.join("|")})$`, "i").test(s)) return false;
  if (/^(?:centro|bairro|jardim|sala|andar|bloco|loja|galp[aã]o|torre|edif[ií]cio|condom[ií]nio|shoppings?)\b/i.test(s)) return false;
  return true;
}

function distanceKm(a: Municipality, b: Municipality): number {
  const radians = Math.PI / 180;
  const lat = (b[2] - a[2]) * radians;
  const lng = (b[3] - a[3]) * radians;
  const h = Math.sin(lat / 2) ** 2
    + Math.cos(a[2] * radians) * Math.cos(b[2] * radians) * Math.sin(lng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Municípios do mesmo UF em ordem de distância à origem resolvida, sem teto de dez. */
export function getNeighboringCities(region: string): string[] {
  return computeExpansionCandidates({
    regions: [region], cityCounts: new Map(), alreadySearched: new Set(), limit: MUNICIPALITIES.length,
  });
}

/** Fallback de busca não muda, substitui nem amplia o nicho solicitado. */
export function proximitySearchTerm(niche: string, region: string): string {
  return `${niche.trim()} perto de ${region.trim()}`;
}

/**
 * API pura preservada. `regions` são as origens solicitadas, nunca os destinos expandidos.
 * Ranking: menor distância a uma origem do próprio UF; empate por nome canônico + UF.
 * `cityCounts` permanece compatível, mas frequência/endereço não comprova proximidade
 * nem autoriza uma origem ambígua. Sem resolução segura, o engine usa proximidade.
 */
export function computeExpansionCandidates(opts: {
  regions: string[];
  cityCounts: Map<string, number>;
  alreadySearched: Set<string>;
  limit: number;
}): string[] {
  const { regions, alreadySearched, limit } = opts;
  if (!Number.isFinite(limit) || limit < 1) return [];
  const origins = new Map<string, Municipality>();
  for (const region of regions) {
    let city = resolveMunicipality(region);
    if (!city) {
      const clean = normalizeKey(region);
      const isExplicitState = STATE_NAMES[clean] || BRAZIL_UFS.some(u => u.toLowerCase() === clean);
      if (isExplicitState) {
        const uf = STATE_NAMES[clean] || clean.toUpperCase();
        const cap = STATE_CAPITALS[uf];
        if (cap) city = resolveMunicipality(`${cap} ${uf}`);
      }
    }
    if (city) origins.set(cityKey(city), city);
  }
  if (!origins.size) return [];
  const originUFs = new Set([...origins.values()].map(city => city[1]));
  const searched = new Set(origins.keys());
  for (const label of [...regions, ...alreadySearched]) {
    const city = resolveMunicipality(label);
    if (city) searched.add(cityKey(city));
    else {
      // Sem UF, homônimos já buscados são excluídos só no escopo das origens válidas.
      for (const match of citiesByName.get(normalizeKey(label)) ?? []) {
        if (originUFs.has(match[1])) searched.add(cityKey(match));
      }
    }
  }
  return MUNICIPALITIES
    .filter(city => originUFs.has(city[1]) && !searched.has(cityKey(city)))
    .map(city => ({
      city,
      key: cityKey(city),
      distance: Math.min(...[...origins.values()].filter(origin => origin[1] === city[1]).map(origin => distanceKm(origin, city))),
    }))
    .sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, Math.floor(limit))
    .map(({ city }) => `${city[0]} - ${city[1]}`);
}
