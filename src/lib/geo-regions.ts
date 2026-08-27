/**
 * geo-regions.ts
 * 
 * Inteligência geográfica para expansão automática de buscas em prospecção.
 * Funciona universalmente para QUALQUER lugar do Brasil:
 * 1. Para capitais e polos mapeados: usa a lista oficial de cidades da região metropolitana.
 * 2. Para qualquer cidade do interior (independente de estar no mapa prévio):
 *    - Detecta o UF de origem (ex: MG, SP, BA, RS, CE...).
 *    - Colhe cidades reais vizinhas que aparecem nos endereços e CEPs dos resultados do Google Maps.
 *    - Blinda contra vazamento de estado: NUNCA expande para fora do estado de origem.
 *    - Rejeita estritamente logradouros, bairros, números e ruídos (ex: "Av. Amazonas", "Rua X").
 */

export const BRAZIL_UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO"
] as const;

export const UF_REGEX = new RegExp(`\\b(${BRAZIL_UFS.join("|")})\\b`, "i");

// Prefixo de logradouro/rua que JAMAIS deve ser tratado como cidade.
export const LOGRADOURO_PREFIX = /^(?:·\s*|[-–—]\s*)?(?:r\.|rua|av\.?|avenida|al\.|alameda|tr\.|travessa|pra[çc]a|pc\.|rod\.?|rodovia|estrada|est\.?|largo|quadra|qd\.|bloco|conjunto|lote|via|trav\.|beco|estradinha|passagem|rod\b)/i;

/** Extrai a sigla de UF de uma string de região/endereço se presente. */
export function extractUFFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(UF_REGEX);
  return match ? match[1].toUpperCase() : null;
}

/** Faixas oficiais de CEP por estado — infere o UF mesmo sem sigla no texto.
 *  Fonte: Correios (prefixo de 2 dígitos). Cobre o Brasil inteiro. */
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
  if (prefix === 69) return null; // RR/AP ambíguos demais sem mais contexto
  for (const [lo, hi, uf] of CEP_RANGES) {
    if (prefix >= lo && prefix <= hi) return uf;
  }
  return null;
}

/** Valida se uma string é um nome de cidade plausível (e não uma rua ou lixo de endereço). */
export function isValidCityName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.replace(/^[·\s\-–—]+/, "").replace(/[·\s\-–—]+$/, "").trim();
  if (s.length < 3 || s.length > 50) return false;
  // Não pode começar com prefixo de logradouro
  if (LOGRADOURO_PREFIX.test(s)) return false;
  // Não pode conter apenas números ou dígitos predominantes
  if (/\d{3,}/.test(s)) return false;
  // Não pode ser uma sigla de UF isolada
  if (/^(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/i.test(s)) return false;
  // Não pode ser termo genérico de endereço
  if (/^(?:centro|bairro|sala|andar|bloco|loja|galp[aã]o|torre|edif[ií]cio|condom[ií]nio|shoppings?)$/i.test(s)) return false;
  return true;
}

/** Mapa de regiões metropolitanas e cidades vizinhas das principais praças brasileiras. */
const METROPOLITAN_NEIGHBORS: Record<string, string[]> = {
  // Minas Gerais
  "belo horizonte": ["Contagem - MG", "Betim - MG", "Nova Lima - MG", "Santa Luzia - MG", "Sabará - MG", "Ibirité - MG", "Ribeirão das Neves - MG", "Vespasiano - MG", "Lagoa Santa - MG", "Sete Lagoas - MG"],
  "bh": ["Contagem - MG", "Betim - MG", "Nova Lima - MG", "Santa Luzia - MG", "Sabará - MG", "Ibirité - MG", "Ribeirão das Neves - MG", "Vespasiano - MG", "Lagoa Santa - MG"],
  "contagem": ["Belo Horizonte - MG", "Betim - MG", "Ibirité - MG", "Ribeirão das Neves - MG", "Esmeraldas - MG"],
  "betim": ["Contagem - MG", "Belo Horizonte - MG", "Igarapé - MG", "Sarzedo - MG", "São Joaquim de Bicas - MG"],
  "uberlandia": ["Araguari - MG", "Uberaba - MG", "Tupaciguara - MG", "Prata - MG", "Monte Alegre de Minas - MG"],
  "juiz de fora": ["Matias Barbosa - MG", "Santos Dumont - MG", "Bicas - MG", "Lima Duarte - MG"],
  "ipatinga": ["Coronel Fabriciano - MG", "Timóteo - MG", "Santana do Paraíso - MG"],
  "montes claros": ["Bocaiuva - MG", "Francisco Sá - MG", "Janaúba - MG", "Pirapora - MG"],
  "divinopolis": ["Nova Serrana - MG", "Itaúna - MG", "Carmo do Cajuru - MG", "São Gonçalo do Pará - MG"],
  "pocos de caldas": ["Andradas - MG", "Caldas - MG", "Botelhos - MG", "Santa Rita de Caldas - MG"],

  // São Paulo
  "sao paulo": ["Guarulhos - SP", "São Bernardo do Campo - SP", "Santo André - SP", "Osasco - SP", "Barueri - SP", "Diadema - SP", "Mauá - SP", "Mogi das Cruzes - SP", "Cotia - SP", "Taboão da Serra - SP", "Carapicuíba - SP", "Itaquaquecetuba - SP", "Santana de Parnaíba - SP"],
  "sp": ["Guarulhos - SP", "São Bernardo do Campo - SP", "Santo André - SP", "Osasco - SP", "Barueri - SP", "Diadema - SP", "Mauá - SP", "Mogi das Cruzes - SP", "Cotia - SP"],
  "guarulhos": ["São Paulo - SP", "Arujá - SP", "Itaquaquecetuba - SP", "Mairiporã - SP"],
  "campinas": ["Paulínia - SP", "Sumaré - SP", "Hortolândia - SP", "Valinhos - SP", "Vinhedo - SP", "Indaiatuba - SP", "Americana - SP", "Jaguariúna - SP"],
  "santos": ["São Vicente - SP", "Praia Grande - SP", "Guarujá - SP", "Cubatão - SP", "Bertioga - SP"],
  "sao jose dos campos": ["Jacareí - SP", "Taubaté - SP", "Caçapava - SP", "Pindamonhangaba - SP"],
  "ribeirao preto": ["Sertãozinho - SP", "Cravinhos - SP", "Jardinópolis - SP", "Brodowski - SP"],
  "sorocaba": ["Votorantim - SP", "Itu - SP", "Salto - SP", "Araçoiaba da Serra - SP"],
  "sao jose do rio preto": ["Mirassol - SP", "Bady Bassitt - SP", "Cedral - SP", "Guapiaçu - SP"],
  "bauru": ["Pederneiras - SP", "Agudos - SP", "Piratininga - SP", "Jaú - SP"],
  "piracicaba": ["Santa Bárbara d'Oeste - SP", "Limeira - SP", "Rio das Pedras - SP", "Capivari - SP"],
  "jundiai": ["Várzea Paulista - SP", "Campo Limpo Paulista - SP", "Itupeva - SP", "Louveira - SP", "Cabreúva - SP"],

  // Rio de Janeiro
  "rio de janeiro": ["Niterói - RJ", "Duque de Caxias - RJ", "São Gonçalo - RJ", "Nova Iguaçu - RJ", "Belford Roxo - RJ", "São João de Meriti - RJ", "Nilópolis - RJ", "Mesquita - RJ", "Magé - RJ", "Itaboraí - RJ"],
  "rj": ["Niterói - RJ", "Duque de Caxias - RJ", "São Gonçalo - RJ", "Nova Iguaçu - RJ", "Belford Roxo - RJ"],
  "niteroi": ["Rio de Janeiro - RJ", "São Gonçalo - RJ", "Maricá - RJ", "Itaboraí - RJ"],
  "campos dos goytacazes": ["Macaé - RJ", "São João da Barra - RJ", "Quissamã - RJ"],
  "volta redonda": ["Barra Mansa - RJ", "Pinheiral - RJ", "Resende - RJ"],

  // Paraná
  "curitiba": ["São José dos Pinhais - PR", "Colombo - PR", "Pinhais - PR", "Araucária - PR", "Campo Largo - PR", "Fazenda Rio Grande - PR", "Almirante Tamandaré - PR", "Piraquara - PR"],
  "londrina": ["Cambé - PR", "Ibiporã - PR", "Rolândia - PR", "Arapongas - PR", "Apucarana - PR"],
  "maringa": ["Sarandi - PR", "Marialva - PR", "Paiçandu - PR", "Mandaguari - PR"],
  "cascavel": ["Toledo - PR", "Corbélia - PR", "Santa Tereza do Oeste - PR"],
  "foz do iguacu": ["Santa Terezinha de Itaipu - PR", "São Miguel do Iguaçu - PR", "Medianeira - PR"],

  // Rio Grande do Sul
  "porto alegre": ["Canoas - RS", "Novo Hamburgo - RS", "São Leopoldo - RS", "Gravataí - RS", "Viamão - RS", "Alvorada - RS", "Cachoeirinha - RS", "Sapucaia do Sul - RS", "Esteio - RS", "Guaíba - RS"],
  "caxias do sul": ["Farroupilha - RS", "Bento Gonçalves - RS", "Flores da Cunha - RS", "Garibaldi - RS"],
  "pelotas": ["Rio Grande - RS", "Capão do Leão - RS", "São Lourenço do Sul - RS"],
  "santa maria": ["Itaara - RS", "São Sepé - RS", "Júlio de Castilhos - RS"],

  // Santa Catarina
  "florianopolis": ["São José - SC", "Palhoça - SC", "Biguaçu - SC", "Santo Amaro da Imperatriz - SC", "Governador Celso Ramos - SC"],
  "joinville": ["Jaraguá do Sul - SC", "São Francisco do Sul - SC", "Araquari - SC", "Guaramirim - SC"],
  "blumenau": ["Gaspar - SC", "Indaial - SC", "Pomerode - SC", "Brusque - SC", "Timbó - SC"],
  "itajai": ["Balneário Camboriú - SC", "Navegantes - SC", "Camboriú - SC", "Itapema - SC", "Penha - SC"],
  "chapeco": ["Chapecó - SC", "Xaxim - SC", "Guatambu - SC", "Cordilheira Alta - SC", "Coronel Freitas - SC"],
  "criciuma": ["Içara - SC", "Cocal do Sul - SC", "Forquilhinha - SC", "Araranguá - SC"],

  // Distrito Federal / Goiás
  "brasilia": ["Taguatinga - DF", "Ceilândia - DF", "Águas Claras - DF", "Samambaia - DF", "Guará - DF", "Gama - DF", "Sobradinho - DF", "Planaltina - DF", "Valparaíso de Goiás - GO", "Águas Lindas de Goiás - GO", "Luziânia - GO"],
  "df": ["Taguatinga - DF", "Ceilândia - DF", "Águas Claras - DF", "Samambaia - DF", "Guará - DF", "Gama - DF"],
  "goiania": ["Aparecida de Goiânia - GO", "Senador Canedo - GO", "Trindade - GO", "Goianira - GO", "Anápolis - GO"],
  "anapolis": ["Goiânia - GO", "Aparecida de Goiânia - GO", "Abadiânia - GO"],

  // Bahia
  "salvador": ["Lauro de Freitas - BA", "Camaçari - BA", "Simões Filho - BA", "Candeias - BA", "Dias d'Ávila - BA", "Feira de Santana - BA"],
  "feira de santana": ["Salvador - BA", "São Gonçalo dos Campos - BA", "Conceição da Feira - BA", "Amélia Rodrigues - BA"],
  "vitoria da conquista": ["Barra do Choça - BA", "Planalto - BA", "Anagé - BA", "Poções - BA"],

  // Pernambuco
  "recife": ["Olinda - PE", "Jaboatão dos Guararapes - PE", "Paulista - PE", "Camaragibe - PE", "São Lourenço da Mata - PE", "Igarassu - PE", "Cabo de Santo Agostinho - PE", "Abreu e Lima - PE"],
  "caruaru": ["Bezerros - PE", "Toritama - PE", "Santa Cruz do Capibaribe - PE", "São Caetano - PE"],
  "petrolina": ["Juazeiro - BA", "Lagoa Grande - PE", "Santa Maria da Boa Vista - PE"],

  // Ceará
  "fortaleza": ["Caucaia - CE", "Maracanaú - CE", "Eusébio - CE", "Aquiraz - CE", "Maranguape - CE", "Pacatuba - CE", "Horizonte - CE", "Itaitinga - CE"],
  "juazeiro do norte": ["Crato - CE", "Barbalha - CE", "Missão Velha - CE"],
  "sobral": ["Forquilha - CE", "Massapê - CE", "Santana do Acaraú - CE"],

  // Espírito Santo
  "vitoria": ["Vila Velha - ES", "Serra - ES", "Cariacica - ES", "Viana - ES", "Guarapari - ES"],
  "cachoeiro de itapemirim": ["Castelo - ES", "Muqui - ES", "Vargem Alta - ES", "Marataízes - ES"],

  // Norte
  "manaus": ["Iranduba - AM", "Manacapuru - AM", "Careiro - AM", "Presidente Figueiredo - AM"],
  "belem": ["Ananindeua - PA", "Marituba - PA", "Benevides - PA", "Castanhal - PA", "Santa Bárbara do Pará - PA"],
  "porto velho": ["Candeias do Jamari - RO", "Itapuã do Oeste - RO"],

  // Centro-Oeste
  "cuiaba": ["Várzea Grande - MT", "Santo Antônio de Leverger - MT", "Chapada dos Guimarães - MT"],
  "campo grande": ["Terenos - MS", "Sidrolândia - MS", "Ribas do Rio Pardo - MS", "Jaraguari - MS"],

  // Nordeste outros
  "natal": ["Parnamirim - RN", "São Gonçalo do Amarante - RN", "Macaíba - RN", "Ceará-Mirim - RN", "Extremoz - RN"],
  "joao pessoa": ["Cabedelo - PB", "Bayeux - PB", "Santa Rita - PB", "Conde - PB"],
  "maceio": ["Marechal Deodoro - AL", "Rio Largo - AL", "Satuba - AL", "Pilar - AL", "Santa Luzia do Norte - AL"],
  "teresina": ["Timon - MA", "Altos - PI", "Demerval Lobão - PI", "José de Freitas - PI"],
  "aracaju": ["Nossa Senhora do Socorro - SE", "São Cristóvão - SE", "Barra dos Coqueiros - SE"],
  "sao luis": ["São José de Ribamar - MA", "Paço do Lumiar - MA", "Raposa - MA"],
};

function normalizeKey(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-–—/,\.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalização canônica de nome de região/cidade — ÚNICA em todo o pipeline
 *  (scraper-engine usa a mesma função para dedupe de buscas/expansões). */
export function normRegionName(str: string): string {
  return normalizeKey(str);
}

/** Retorna lista de cidades vizinhas/metropolitanas conhecidas para a região informada. */
export function getNeighboringCities(region: string): string[] {
  if (!region) return [];
  const clean = normalizeKey(region);

  // 1. Busca exata
  if (METROPOLITAN_NEIGHBORS[clean]) {
    return METROPOLITAN_NEIGHBORS[clean];
  }

  // 2. Busca parcial (ex: "Belo Horizonte - MG" → "belo horizonte")
  for (const [key, neighbors] of Object.entries(METROPOLITAN_NEIGHBORS)) {
    if (clean === key || clean.startsWith(key + " ") || clean.includes(" " + key) || clean.endsWith(" " + key)) {
      return neighbors;
    }
  }

  return [];
}

/** Prefixo de busca de PROXIMIDADE — usado quando não há nenhum candidato de expansão. */
export function proximitySearchTerm(niche: string, region: string): string {
  return `${niche.trim()} perto de ${region.trim()}`;
}

/**
 * Decide QUAIS cidades vizinhas expandir, pura e testável.
 * Camadas:
 *  1) Região metropolitana conhecida (metropolises mapeadas);
 *  2) Cidades colhidas dos endereços reais (cityCounts — chave "Cidade - UF" ou "Cidade");
 * Blindagem estadual: se o estado de origem é conhecido, só aceita do mesmo UF.
 * Nada entra se for rua/logradouro/ruído (isValidCityName).
 */
export function computeExpansionCandidates(opts: {
  regions: string[];
  cityCounts: Map<string, number>;
  alreadySearched: Set<string>;
  limit: number;
}): string[] {
  const norm = normalizeKey;
  const { regions, cityCounts, alreadySearched, limit } = opts;
  // Conjunto com chaves 100% normalizadas (tolera Sets alimentados com strings cruas)
  const searchedNorm = new Set<string>();
  for (const s of alreadySearched) searchedNorm.add(norm(s));

  let targetUF: string | null = null;
  for (const r of regions) {
    const uf = extractUFFromText(r);
    if (uf) { targetUF = uf; break; }
  }
  const baseNames = regions.map(r => norm(r.replace(/[-,/]?\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i, "")));

  const isOriginal = (city: string) => {
    const c = norm(city);
    return baseNames.some(b => c === b || c.startsWith(b + " ") || b.startsWith(c + " "));
  };

  const out: string[] = [];
  const push = (c: string) => {
    if (!out.some(x => norm(x) === norm(c))) out.push(c);
  };

  // 1) Metropolitanas conhecidas
  for (const reg of regions) {
    for (const n of getNeighboringCities(reg)) {
      const uf = extractUFFromText(n);
      if (targetUF && uf && uf !== targetUF) continue;
      if (searchedNorm.has(norm(n))) continue;
      if (isOriginal(n)) continue;
      push(n);
    }
  }

  // 2) Dinâmicas (endereços reais dos leads)
  const dyn = [...cityCounts.entries()]
    .filter(([label]) => {
      if (searchedNorm.has(norm(label))) return false;
      const m = label.match(/\s-\s([A-Z]{2})$/);
      const cityOnly = m ? label.slice(0, m.index).trim() : label;
      if (!isValidCityName(cityOnly)) return false;
      if (isOriginal(cityOnly)) return false;
      const uf = m ? m[1] : null;
      if (targetUF && uf && uf !== targetUF) return false;
      return true;
    })
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  for (const d of dyn) {
    const named = /\s-\s[A-Z]{2}$/.test(d) ? d : (targetUF ? `${d} - ${targetUF}` : d);
    push(named);
  }

  return out.slice(0, limit);
}
