"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { leadRowToTemplateContext, renderTemplate } from "@/lib/template-vars";

export type PreviewLead = {
  id: number;
  remoteJid: string;
  nome_negocio: string | null;
  ramo_negocio: string | null;
  categoria: string | null;
  endereco: string | null;
  website: string | null;
  telefone: string | null;
  avaliacao?: number | string | null;
  reviews?: number | string | null;
  resumo_avaliacoes?: string | null;
  year_established?: number | string | null;
  instagram?: string | null;
  facebook?: string | null;
  maps_url?: string | null;
  cep?: string | null;
  plus_code?: string | null;
  price_range?: string | null;
  open_now?: string | null;
  opening_hours?: unknown;
  attributes?: unknown;
  business_details?: Record<string, unknown> | null;
  business_status?: string | null;
  claimed?: boolean | string | null;
  owner_name?: string | null;
  total_photo_count?: number | string | null;
  photos?: unknown;
  review_topics?: unknown;
  featured_reviews?: unknown;
  additional_categories?: unknown;
  address_components?: Record<string, unknown> | null;
  distribuicao_estrelas?: unknown;
  reviews_detalhes?: unknown;
  link_previa?: string | null;
  email?: string | null;
  observacoes?: string | null;
  status?: string | null;
};

export type PreviewSample = {
  nome_negocio: string;
  ramo_negocio: string;
  push_name: string;
  telefone: string;
  endereco: string;
  categoria: string;
  website: string;
  avaliacao?: string;
  reviews?: string;
  resumo_avaliacoes?: string;
  ano_google?: string;
  instagram?: string;
  facebook?: string;
  cidade?: string;
  bairro?: string;
  estado?: string;
  cep?: string;
  maps_url?: string;
  horario_funcionamento?: string;
  aberto_agora?: string;
  faixa_preco?: string;
  atributos?: string;
  proprietario?: string;
  reivindicado?: string;
  total_fotos?: string;
  topicos_avaliacoes?: string;
  categorias_adicionais?: string;
  descricao_google?: string;
  link_previa?: string;
  email?: string;
  observacoes?: string;
};

export const DEFAULT_PREVIEW_SAMPLE: PreviewSample = {
  nome_negocio: "Padaria Centro",
  ramo_negocio: "Alimentação",
  push_name: "João",
  telefone: "11999998888",
  endereco: "Rua A, 123 - Centro, São Paulo - SP, 01001-000",
  categoria: "Padaria",
  website: "padariacentro.com.br",
  avaliacao: "4.8",
  reviews: "127",
  resumo_avaliacoes: "Clientes elogiam o pão francês quentinho, doces frescos e atendimento rápido.",
  ano_google: "2019",
  instagram: "@padariacentro",
  facebook: "facebook.com/padariacentro",
  cidade: "São Paulo",
  bairro: "Centro",
  estado: "SP",
  cep: "01001-000",
  maps_url: "https://maps.google.com/?cid=123456789",
  horario_funcionamento: "Seg a Sáb: 06:00 às 20:00 | Dom: 07:00 às 14:00",
  aberto_agora: "Aberto agora",
  faixa_preco: "R$ 20–40",
  atributos: "Entrega, Para viagem, Café da manhã, Acessível para cadeirantes",
  proprietario: "Carlos Silva",
  reivindicado: "Sim",
  total_fotos: "42",
  topicos_avaliacoes: "pão francês (18), atendimento (12), café da manhã (9)",
  categorias_adicionais: "Confeitaria, Cafeteria",
  descricao_google: "Padaria e confeitaria tradicional no Centro de São Paulo.",
  link_previa: "https://padaria-centro.vercel.app",
  email: "contato@padariacentro.com.br",
  observacoes: "Cliente com boa reputação no Google Maps",
};

export function leadToPreviewSample(lead: PreviewLead): PreviewSample {
  const ctx = leadRowToTemplateContext(lead as Record<string, unknown>);
  const resolveKey = (k: string) => {
    const out = renderTemplate(`{{${k}}}`, ctx);
    return out === `{{${k}}}` ? "" : out;
  };
  return {
    nome_negocio: lead.nome_negocio || "",
    ramo_negocio: lead.ramo_negocio || lead.categoria || "",
    push_name: "",
    telefone: lead.telefone || (lead.remoteJid || "").replace(/@.*$/, "").replace(/\D/g, ""),
    endereco: lead.endereco || "",
    categoria: lead.categoria || lead.ramo_negocio || "",
    website: lead.website || "",
    avaliacao: resolveKey("avaliacao"),
    reviews: resolveKey("reviews"),
    resumo_avaliacoes: resolveKey("resumo_avaliacoes"),
    ano_google: resolveKey("ano_google"),
    instagram: resolveKey("instagram"),
    facebook: resolveKey("facebook"),
    cidade: resolveKey("cidade"),
    bairro: resolveKey("bairro"),
    estado: resolveKey("estado"),
    cep: resolveKey("cep"),
    maps_url: resolveKey("maps_url"),
    horario_funcionamento: resolveKey("horario_funcionamento"),
    aberto_agora: resolveKey("aberto_agora"),
    faixa_preco: resolveKey("faixa_preco"),
    atributos: resolveKey("atributos"),
    proprietario: resolveKey("proprietario"),
    reivindicado: resolveKey("reivindicado"),
    total_fotos: resolveKey("total_fotos"),
    topicos_avaliacoes: resolveKey("topicos_avaliacoes"),
    categorias_adicionais: resolveKey("categorias_adicionais"),
    descricao_google: resolveKey("descricao_google"),
    link_previa: resolveKey("link_previa"),
    email: resolveKey("email"),
    observacoes: resolveKey("observacoes"),
  };
}

export function LeadSelectorUI({
  sample,
  setSample,
  leads,
  leadsLoading,
  selectedLeadId,
  onSelectLead,
  leadQuery,
  setLeadQuery,
}: {
  sample: PreviewSample;
  setSample: (s: PreviewSample) => void;
  leads: PreviewLead[];
  leadsLoading: boolean;
  selectedLeadId: number | null;
  onSelectLead: (lead: PreviewLead) => void;
  leadQuery: string;
  setLeadQuery: (v: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showMoreMapsFields, setShowMoreMapsFields] = useState(false);

  const filteredLeads = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    if (!q) return leads.slice(0, 50);
    return leads
      .filter((l) =>
        (l.nome_negocio || "").toLowerCase().includes(q) ||
        (l.telefone || "").toLowerCase().includes(q) ||
        (l.remoteJid || "").toLowerCase().includes(q) ||
        (l.categoria || "").toLowerCase().includes(q) ||
        (l.ramo_negocio || "").toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [leads, leadQuery]);

  const selectedLead = leads.find((l) => l.id === selectedLeadId) || null;

  const primaryFields: Array<[keyof PreviewSample, string]> = [
    ["nome_negocio", "Nome empresa"],
    ["ramo_negocio", "Ramo"],
    ["push_name", "Nome WhatsApp"],
    ["telefone", "Telefone"],
    ["categoria", "Categoria"],
    ["endereco", "Endereço"],
    ["website", "Website"],
    ["avaliacao", "Nota Google ({{nota}})"],
    ["reviews", "Avaliações ({{avaliacoes}})"],
    ["ano_google", "No Google desde ({{ano_google}})"],
    ["cidade", "Cidade ({{cidade}})"],
    ["instagram", "Instagram ({{instagram}})"],
  ];

  const extraMapsFields: Array<[keyof PreviewSample, string]> = [
    ["resumo_avaliacoes", "Resumo avaliações ({{resumo_avaliacoes}})"],
    ["bairro", "Bairro ({{bairro}})"],
    ["estado", "Estado / UF ({{estado}})"],
    ["cep", "CEP ({{cep}})"],
    ["horario_funcionamento", "Horário func. ({{horario_funcionamento}})"],
    ["aberto_agora", "Aberto agora ({{aberto_agora}})"],
    ["faixa_preco", "Faixa de preço ({{faixa_preco}})"],
    ["atributos", "Atributos Maps ({{atributos}})"],
    ["maps_url", "Link Maps ({{maps_url}})"],
    ["facebook", "Facebook ({{facebook}})"],
    ["proprietario", "Proprietário ({{proprietario}})"],
    ["reivindicado", "Perfil reivindicado ({{reivindicado}})"],
    ["total_fotos", "Total de fotos ({{total_fotos}})"],
    ["topicos_avaliacoes", "Tópicos avaliações ({{topicos_avaliacoes}})"],
    ["categorias_adicionais", "Categorias extras ({{categorias_adicionais}})"],
    ["descricao_google", "Descrição Maps ({{descricao_google}})"],
    ["link_previa", "Link prévia site ({{link_previa}})"],
    ["email", "Email ({{email}})"],
    ["observacoes", "Observações ({{observacoes}})"],
  ];

  return (
    <div className="rounded-xl bg-black/30 border border-white/5 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-black uppercase tracking-widest text-cyan-300">Simular com qual cliente?</p>
        {selectedLead && (
          <span className="text-[10px] text-emerald-300 font-mono">
            ✓ usando: {selectedLead.nome_negocio || selectedLead.telefone || selectedLead.remoteJid?.replace(/@.*$/, "")}
          </span>
        )}
      </div>

      {/* Picker dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10 hover:border-cyan-500/40 transition text-left"
        >
          <span className="text-[12px] text-white truncate">
            {selectedLead ? (
              <>
                <span className="font-bold">{selectedLead.nome_negocio || "(sem nome)"}</span>
                <span className="text-muted-foreground ml-2 text-[10px]">{selectedLead.telefone || selectedLead.remoteJid?.replace(/@.*$/, "")}</span>
                {selectedLead.ramo_negocio && <span className="text-muted-foreground ml-2 text-[10px]">· {selectedLead.ramo_negocio}</span>}
                {selectedLead.avaliacao != null && <span className="text-yellow-300/80 ml-2 text-[10px]">★ {selectedLead.avaliacao}</span>}
                {selectedLead.reviews != null && <span className="text-muted-foreground ml-1 text-[10px]">({selectedLead.reviews})</span>}
              </>
            ) : (
              <span className="text-muted-foreground italic">Clique pra escolher um cliente da sua base… ({leads.length} disponíveis)</span>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono shrink-0">{pickerOpen ? "▲" : "▼"}</span>
        </button>

        {pickerOpen && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-xl bg-[#0a0a0a] border border-cyan-500/20 shadow-2xl overflow-hidden">
            <div className="p-2 border-b border-white/5">
              <input
                autoFocus
                value={leadQuery}
                onChange={(e) => setLeadQuery(e.target.value)}
                placeholder="Buscar por nome, telefone, ramo, categoria..."
                className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-1.5 text-[12px] text-white focus:border-cyan-500/50 outline-none"
              />
            </div>
            <div className="max-h-72 overflow-y-auto custom-scrollbar">
              {leadsLoading ? (
                <div className="p-3 text-[11px] text-muted-foreground italic">Carregando clientes...</div>
              ) : filteredLeads.length === 0 ? (
                <div className="p-3 text-[11px] text-muted-foreground italic">
                  {leads.length === 0 ? "Nenhum cliente cadastrado." : "Nenhum cliente bate com a busca."}
                </div>
              ) : (
                filteredLeads.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      onSelectLead(l);
                      setPickerOpen(false);
                      setLeadQuery("");
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 hover:bg-cyan-500/10 transition border-b border-white/[0.03] last:border-0",
                      selectedLeadId === l.id && "bg-cyan-500/10"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[12px] font-bold text-white truncate">
                          {l.nome_negocio || <span className="italic text-muted-foreground">(sem nome)</span>}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">
                          {l.telefone || (l.remoteJid || "").replace(/@.*$/, "")}
                          {l.ramo_negocio && <span className="ml-2">· {l.ramo_negocio}</span>}
                          {l.categoria && <span className="ml-2">· {l.categoria}</span>}
                          {l.avaliacao != null && <span className="ml-2 text-yellow-300/80">★ {l.avaliacao}</span>}
                          {l.reviews != null && <span className="ml-1">({l.reviews} av.)</span>}
                        </p>
                      </div>
                      {selectedLeadId === l.id && <span className="text-cyan-300 text-[10px] font-bold shrink-0">✓ atual</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
            {leads.length > filteredLeads.length && (
              <div className="p-2 text-[9px] text-muted-foreground text-center border-t border-white/5">
                Mostrando {filteredLeads.length} de {leads.length}. Refine a busca pra ver mais.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Editable fields grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-white/5">
        {primaryFields.map(([k, label]) => (
          <div key={k}>
            <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-black">{label}</label>
            <input
              value={sample[k] || ""}
              onChange={(e) => setSample({ ...sample, [k]: e.target.value })}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[11px] font-mono text-white focus:border-cyan-500/50 outline-none"
            />
          </div>
        ))}
      </div>

      {/* Expandable extra Maps fields */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setShowMoreMapsFields((v) => !v)}
          className="text-[10px] font-semibold text-cyan-300/80 hover:text-cyan-200 transition cursor-pointer"
        >
          {showMoreMapsFields
            ? "▲ Ocultar campos extras do Google Maps"
            : "▼ Ver mais campos do Google Maps (horários, bairro, CEP, faixa de preço, resumo IA, atributos...)"}
        </button>

        {showMoreMapsFields && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 mt-2 border-t border-white/5">
            {extraMapsFields.map(([k, label]) => (
              <div key={k}>
                <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-black">{label}</label>
                <input
                  value={sample[k] || ""}
                  onChange={(e) => setSample({ ...sample, [k]: e.target.value })}
                  className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[11px] font-mono text-white focus:border-cyan-500/50 outline-none"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[9px] text-muted-foreground italic">
        Os campos são preenchidos automaticamente ao escolher um lead. Você ainda pode editar manualmente pra simular cenários hipotéticos.
      </p>
    </div>
  );
}
