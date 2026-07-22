"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Book, Check, Info, Pencil, Plus, Save, Settings, Trash2, Wrench, X, Image as ImageIcon, Upload, Loader2, Sparkles } from "lucide-react";
import { SaveButton } from "../_components/save-button";
import { EmptyState } from "../_components/empty-state";
import { CopyButton } from "../_components/copy-button";
import { PromptPreview } from "../_components/prompt-preview";
import { Toggle, type ToggleColor } from "../_components/toggle";
import { WebhookGuide } from "../_components/webhook-guide";
import type { PreviewLead, PreviewSample } from "../_components/lead-selector";
import { ModelOptions } from "@/components/ai-module-shared";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

// Variáveis que aparecem como chips clicáveis no editor de prompt.
const PROMPT_VARIABLES = [
  { key: "saudacao",      label: "Saudação",     hint: "Bom dia/Boa tarde/Boa noite/Boa madrugada (hora SP)" },
  { key: "nome",          label: "Nome",         hint: "Push name do WhatsApp (com fallback pra empresa)" },
  { key: "nome_empresa",  label: "Nome empresa", hint: "Do CRM (leads_extraidos.nome_negocio)" },
  { key: "primeiro_nome", label: "1ª palavra",   hint: "Primeira palavra do nome da empresa" },
  { key: "ramo",          label: "Ramo",         hint: "Ramo de negócio do CRM" },
  { key: "categoria",     label: "Categoria",    hint: "Categoria do lead (Google)" },
  { key: "endereco",      label: "Endereço",     hint: "Endereço do lead" },
  { key: "website",       label: "Website",      hint: "Site do lead" },
  { key: "telefone",      label: "Telefone",     hint: "Número limpo do WhatsApp" },
  { key: "data",          label: "Data",         hint: "Data atual" },
  { key: "hora",          label: "Hora",         hint: "Hora atual" },
];

// Apenas perguntas diretas que a IA precisa fazer ao cliente.
// Telefone vem do JID, empresa/necessidade são inferidas pela IA sem perguntar.
const CALENDAR_FIELDS = [
  { key: "nome",  label: "Nome completo", hint: "IA pergunta ao cliente antes de agendar" },
  { key: "email", label: "E-mail",        hint: "IA pergunta. Cliente vira convidado oficial do evento (recebe convite)" },
] as const;

// Os 3 campos de captura automática. O "necessidade" tem LABEL DINÂMICO
// que se adapta ao nicho (Salão → "Serviço", Médico → "Especialidade", etc).
// O label é editável pelo usuário e renderiza no Google Calendar + /calendario.
const CALENDAR_AUTO_CAPTURE_FIELDS = [
  { key: "telefone" as const,    label: "Telefone",                          desc: "Número do WhatsApp da conversa vai pra descrição do evento" },
  { key: "empresa" as const,     label: "Empresa",                           desc: "IA infere da conversa se for mencionada" },
  { key: "necessidade" as const, label: "Dor / Necessidade / Serviço",        desc: "IA resume o motivo do contato (vira o nome do serviço no calendário)" },
];

// Presets de nicho: clica e popula automaticamente o label de "necessidade"
// + sugere descrição que se encaixa. Comerciais B2B continuam usando "Dor".
const NICHE_PRESETS = [
  { id: "comercial", label: "Comercial (B2B)",   nec_label: "Dor / Necessidade",  hint: "Resumo da dor que motivou o contato" },
  { id: "salao",     label: "Salão de beleza",   nec_label: "Serviço desejado",   hint: "Tipo de procedimento (corte, manicure, escova...)" },
  { id: "medico",    label: "Clínica / Médico",  nec_label: "Especialidade",      hint: "Especialidade ou sintoma principal" },
  { id: "advocacia", label: "Advocacia",         nec_label: "Causa",              hint: "Tipo de questão jurídica" },
  { id: "imobi",     label: "Imobiliária",       nec_label: "Imóvel de interesse", hint: "Tipo/região/perfil que o cliente busca" },
  { id: "educ",      label: "Educação / Curso",  nec_label: "Curso de interesse", hint: "Curso ou área que o cliente quer" },
];

export type InfoTabProps = {
  // Identidade
  nomeAgente: string; setNomeAgente: (v: string) => void;
  funcaoAgente: string; setFuncaoAgente: (v: string) => void;
  personalidadeAgente: string; setPersonalidadeAgente: (v: string) => void;
  tomAgente: string; setTomAgente: (v: string) => void;
  isActiveAgente: boolean; setIsActiveAgente: (v: boolean) => void;
  targetModel: string; setTargetModel: (v: string) => void;
  modelOptions: any[];
  isAdmin?: boolean;  // só admin vê/altera modelo de IA (controle de custo)
  defaultAiModel?: string | null;  // modelo padrão da conta definido pelo admin
  appUrl: string; setAppUrl: (v: string) => void;
  vinculoInstance: string; setVinculoInstance: (v: string) => void;
  allInstances: string[];
  savingVinculo: boolean;
  onSaveVinculo: (instanceName: string) => void;
  messageBufferSeconds: number; setMessageBufferSeconds: (n: number) => void;
  humanizeMessages: boolean; setHumanizeMessages: (v: boolean) => void;
  webSearchEnabled: boolean; setWebSearchEnabled: (v: boolean) => void;
  reasoningMode: 0 | 1 | 2; setReasoningMode: (n: 0 | 1 | 2) => void;
  leadIntelligenceEnabled: boolean; setLeadIntelligenceEnabled: (v: boolean) => void;
  saveIdentity: () => void;
  savingConfig: boolean;
  toggleAgentActive: () => void;

  // Calendar
  calendarEnabled: boolean; setCalendarEnabled: (v: boolean) => void;
  googleJson: string; setGoogleJson: (v: string) => void;
  onTestGoogle: () => void; testingGoogle?: boolean;
  calendarDefaultDuration: number; setCalendarDefaultDuration: (n: number) => void;
  calendarGenerateMeet: boolean; setCalendarGenerateMeet: (v: boolean) => void;
  calendarSendMeetLink: boolean; setCalendarSendMeetLink: (v: boolean) => void;
  calendarOptionalFields: Record<string, boolean>; setCalendarOptionalFields: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  calendarAutoCapture: {
    telefone: boolean;
    empresa: boolean;
    necessidade: boolean;
    /** Label customizado pro "necessidade" — adapta o agente ao nicho.
        Ex: "Serviço desejado" pra salão, "Especialidade" pra médico. */
    necessidade_label?: string;
  };
  setCalendarAutoCapture: (fn: (prev: any) => any) => void;
  saveCalendarConfig: () => void;

  // Scheduler (lembretes automáticos + auto-promote kanban)
  isScheduler: boolean; setIsScheduler: (v: boolean) => void;
  reminders: { offset_minutes: number; message: string }[];
  setReminders: (fn: any) => void;
  autoPromoteAfter: number; setAutoPromoteAfter: (n: number) => void;
  notifyOwner: boolean; setNotifyOwner: (v: boolean) => void;
  ownerPhone: string; setOwnerPhone: (v: string) => void;
  // Resumo IA pro dono (agendamento/cancelamento/reagendamento)
  ownerSummaryEnabled: boolean; setOwnerSummaryEnabled: (v: boolean) => void;
  ownerSummaryPrompt: string; setOwnerSummaryPrompt: (v: string) => void;
  ownerSummaryModel: string; setOwnerSummaryModel: (v: string) => void;
  // Auto-mover kanban: De [coluna] → Para [coluna]
  autoPromoteFrom: string; setAutoPromoteFrom: (v: string) => void;
  autoPromoteTo: string; setAutoPromoteTo: (v: string) => void;
  // Pausa a IA após agendar com sucesso para um contato (minutos). 0 = off.
  pauseAfterSchedule: number; setPauseAfterSchedule: (n: number) => void;
  kanbanColumns: { status_key: string; label: string }[];

  // Webhook
  webhookUrl: string;
  onSyncWebhook: () => void;

  // Prompt
  prompt: string; setPrompt: (v: string) => void;
  promptRef: React.RefObject<HTMLTextAreaElement | null>;
  insertVariable: (key: string) => void;
  insertKbVariable: (title: string) => void;
  savePrompt: () => void;
  knowledge: any[];

  // Prompt preview
  previewSample: PreviewSample; setPreviewSample: (s: PreviewSample) => void;
  previewOpen: boolean; setPreviewOpen: (v: boolean) => void;
  previewLeads: PreviewLead[]; previewLeadsLoading: boolean;
  loadPreviewLeads: () => void;
  previewSelectedLeadId: number | null;
  applyLeadToSample: (l: PreviewLead) => void;
  previewLeadQuery: string; setPreviewLeadQuery: (v: string) => void;

  // Knowledge base CRUD
  showNovoK: boolean; setShowNovoK: (v: boolean) => void;
  novoKTitle: string; setNovoKTitle: (v: string) => void;
  novoKContent: string; setNovoKContent: (v: string) => void;
  salvarNovoKnowledge: () => void;
  editKId: string | null;
  editKTitle: string; setEditKTitle: (v: string) => void;
  editKContent: string; setEditKContent: (v: string) => void;
  iniciarEdicaoKnowledge: (k: any) => void;
  cancelarEdicaoKnowledge: () => void;
  salvarEdicaoKnowledge: () => void;
  deletarKnowledge: (id: string) => void;
};

async function uploadImageToStorage(file: File): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload-media", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      toast.error(data.error || "Erro no upload da imagem.");
      return null;
    }
    return data.url;
  } catch (err: any) {
    toast.error("Erro ao fazer upload da foto: " + err.message);
    return null;
  }
}

interface CatalogProduct {
  id: string;
  name: string;
  price: string;
  stock: string;
  specs: string;
  imageUrl: string;
}

function ProductCatalogBuilder({
  onAppendCatalog,
}: {
  onAppendCatalog: (formattedText: string) => void;
}) {
  const [products, setProducts] = useState<CatalogProduct[]>([
    { id: "1", name: "", price: "", stock: "5", specs: "", imageUrl: "" },
  ]);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);

  const addProduct = () => {
    setProducts((prev) => [
      ...prev,
      { id: String(Date.now()), name: "", price: "", stock: "5", specs: "", imageUrl: "" },
    ]);
  };

  const removeProduct = (index: number) => {
    setProducts((prev) => prev.filter((_, i) => i !== index));
  };

  const updateProduct = (index: number, patch: Partial<CatalogProduct>) => {
    setProducts((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p))
    );
  };

  const handleGenerate = () => {
    const valid = products.filter((p) => p.name.trim().length > 0);
    if (valid.length === 0) {
      toast.error("Preencha o nome de pelo menos um produto.");
      return;
    }

    const blocks = valid.map((p) => {
      const lines = [`### PRODUTO: ${p.name.trim()}`];
      if (p.price.trim()) lines.push(`- **Preço**: ${p.price.trim()}`);
      if (p.stock.trim()) lines.push(`- **Estoque Disponível**: ${p.stock.trim()}`);
      if (p.specs.trim()) lines.push(`- **Especificações / Detalhes**: ${p.specs.trim()}`);
      if (p.imageUrl.trim()) lines.push(`- **Foto Oficial**: [IMAGEM: ${p.imageUrl.trim()}]`);
      return lines.join("\n");
    });

    const formatted = blocks.join("\n\n---\n\n");
    onAppendCatalog(formatted);
    toast.success(`${valid.length} produto(s) formatado(s) e inserido(s)!`);
  };

  return (
    <div className="p-4 rounded-2xl bg-slate-900/90 border border-blue-500/30 space-y-4 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-blue-400" />
          <h4 className="text-xs font-black uppercase tracking-wider text-blue-400">
            🛍️ Construtor de Produtos & Estoque (Qualquer Nicho - Anti-Alucinação)
          </h4>
        </div>
        <Button
          type="button"
          onClick={addProduct}
          variant="outline"
          size="sm"
          className="h-7 text-[10px] font-bold gap-1 bg-blue-500/10 border-blue-500/30 text-blue-300 hover:bg-blue-500/20"
        >
          <Plus className="w-3 h-3" /> + Adicionar Produto
        </Button>
      </div>

      <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
        {products.map((prod, idx) => (
          <div
            key={prod.id}
            className="p-3 bg-black/50 border border-white/10 rounded-xl space-y-3 relative group"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase text-blue-400">
                Item #{idx + 1}
              </span>
              {products.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeProduct(idx)}
                  className="text-red-400 hover:text-red-300 text-xs cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <div>
                <label className="text-[9px] font-bold text-muted-foreground uppercase">
                  Produto / Serviço *
                </label>
                <Input
                  value={prod.name}
                  onChange={(e) => updateProduct(idx, { name: e.target.value })}
                  placeholder="Ex: Camiseta Polo P, iPhone 15, Ap 302"
                  className="h-8 text-xs bg-black/60 border-white/10"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-muted-foreground uppercase">
                  Preço / Valor
                </label>
                <Input
                  value={prod.price}
                  onChange={(e) => updateProduct(idx, { price: e.target.value })}
                  placeholder="Ex: R$ 149 ou 10x R$ 15"
                  className="h-8 text-xs bg-black/60 border-white/10"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-muted-foreground uppercase">
                  Estoque Disponível
                </label>
                <Input
                  value={prod.stock}
                  onChange={(e) => updateProduct(idx, { stock: e.target.value })}
                  placeholder="Ex: 5 unidades ou 1"
                  className="h-8 text-xs bg-black/60 border-white/10"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-muted-foreground uppercase">
                  Detalhes / Estado / Specs
                </label>
                <Input
                  value={prod.specs}
                  onChange={(e) => updateProduct(idx, { specs: e.target.value })}
                  placeholder="Ex: 87% bateria, Cor Azul, Novo"
                  className="h-8 text-xs bg-black/60 border-white/10"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <div className="flex-1 min-w-0">
                <Input
                  value={prod.imageUrl}
                  onChange={(e) => updateProduct(idx, { imageUrl: e.target.value })}
                  placeholder="Link da foto (ou envie o arquivo ao lado)"
                  className="h-8 text-[11px] bg-black/60 border-white/10 font-mono"
                />
              </div>
              <label className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors shrink-0 shadow-md">
                {uploadingIdx === idx ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5" />
                )}
                Anexar Foto
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingIdx === idx}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploadingIdx(idx);
                    const url = await uploadImageToStorage(file);
                    setUploadingIdx(null);
                    if (url) {
                      updateProduct(idx, { imageUrl: url });
                      toast.success(`Foto enviada com sucesso para Item #${idx + 1}!`);
                    }
                  }}
                />
              </label>

              {prod.imageUrl && (
                <div className="h-9 w-9 rounded-lg border border-blue-500/40 overflow-hidden bg-black shrink-0 relative">
                  <img
                    src={prod.imageUrl}
                    alt={prod.name || "Foto produto"}
                    className="h-full w-full object-cover"
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end pt-1">
        <Button
          type="button"
          onClick={handleGenerate}
          className="h-9 px-4 text-xs font-bold gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-lg"
        >
          <Sparkles className="w-3.5 h-3.5" /> Inserir Produtos Formatados no Conteúdo
        </Button>
      </div>
    </div>
  );
}

export function InfoTab(p: InfoTabProps) {
  const [uploadingImg, setUploadingImg] = useState(false);
  return (
    <div className="space-y-12 animate-in fade-in duration-500">
      {/* ========= SEÇÃO 1: IDENTIDADE ========= */}
      <section className="glass-card p-4 sm:p-8 rounded-2xl sm:rounded-[2rem] border-white/10 space-y-4 sm:space-y-6 bg-white/[0.02]">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <h3 className="text-lg font-black tracking-tight flex items-center gap-2">Identidade do Agente</h3>
          <div className="flex items-center gap-2">
            <span className={cn("text-[9px] font-bold", p.isActiveAgente ? "text-green-400" : "text-red-400")}>
              {p.isActiveAgente ? "ATIVO" : "DESLIGADO"}
            </span>
            <Toggle
              checked={p.isActiveAgente}
              onCheckedChange={p.toggleAgentActive}
              color="green"
              size="lg"
              aria-label="Ativar agente"
              className={cn(p.isActiveAgente && "shadow-glow")}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Coluna esquerda: Nome, Modelo, App URL */}
          <div className="space-y-4">
            <Field label="Nome do Agente" copy={p.nomeAgente}>
              <Input value={p.nomeAgente} onChange={(e) => p.setNomeAgente(e.target.value)} className="bg-white/5 border-white/10 h-12 rounded-xl text-sm" />
            </Field>

            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Modelo de IA (LLM) — Gemini ou OpenRouter</label>
              {p.isAdmin ? (
                <>
                  <select
                    value={p.targetModel}
                    onChange={(e) => p.setTargetModel(e.target.value)}
                    className="w-full bg-white/5 border-white/10 text-white h-12 rounded-xl text-sm px-3 focus:outline-none"
                  >
                    {p.targetModel && !p.modelOptions.some((m) => m.id === p.targetModel) && (
                      <option key={p.targetModel} value={p.targetModel} className="bg-neutral-900">
                        {p.targetModel} (salvo)
                      </option>
                    )}
                    {p.modelOptions.length === 0 && !p.targetModel && (
                      <option value="" className="bg-neutral-900 text-muted-foreground">
                        Configure a API Key em Configurações primeiro…
                      </option>
                    )}
                    <ModelOptions models={p.modelOptions as any} markNoTools />
                  </select>
                  <p className="text-[9px] text-muted-foreground mt-1 px-1">
                    {p.modelOptions.length > 0
                      ? <>{p.modelOptions.length} modelos (Gemini + OpenRouter) · só admin altera. O agente usa ferramentas (agenda, base de conhecimento) — prefira modelos sem o aviso "⚠ sem ferramentas".</>
                      : <>⚠ Lista de modelos vazia. Configure a chave do Gemini ou OpenRouter em <a href="/configuracoes" className="text-primary underline decoration-dotted">Configurações</a>.</>}
                  </p>
                </>
              ) : (
                <div className="w-full bg-white/5 border border-white/10 h-12 rounded-xl text-sm px-3 flex items-center text-muted-foreground">
                  <span className="font-mono text-white/80">{p.targetModel || p.defaultAiModel || "—"}</span>
                  <span className="ml-auto text-[9px] uppercase tracking-widest text-purple-300/70">definido pelo admin</span>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-white/5 mt-4 space-y-4">
              <Field label="App URL" copy={p.appUrl} copyLabel="URL">
                <Input value={p.appUrl} onChange={(e) => p.setAppUrl(e.target.value)} placeholder="..." className="bg-white/5 border-white/10 h-10 rounded-xl text-xs" />
              </Field>
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
                <Info className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                <p className="text-[10px] text-primary/90 leading-relaxed">
                  A <strong>API Key do Gemini</strong> é agora uma só pra todo o sistema. Configure em{" "}
                  <a href="/configuracoes" className="underline decoration-dotted font-bold hover:text-primary">Configurações</a>.
                </p>
              </div>
            </div>
          </div>

          {/* Coluna direita: Vínculo, Buffer, Humanizar, Web Search, Função */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-primary">Instância WhatsApp Vinculada</label>
                {p.savingVinculo ? (
                  <span className="text-[9px] font-black uppercase tracking-widest text-yellow-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" /> Salvando…
                  </span>
                ) : p.vinculoInstance ? (
                  <span className="text-[9px] font-black uppercase tracking-widest text-green-400 flex items-center gap-1">
                    <Check className="w-2.5 h-2.5" /> Vinculada
                  </span>
                ) : null}
              </div>
              <select
                value={p.allInstances.includes(p.vinculoInstance) ? p.vinculoInstance : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  p.setVinculoInstance(v);
                  if (v) p.onSaveVinculo(v);
                }}
                className="w-full bg-white/5 border-primary/20 text-white h-12 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="" className="bg-neutral-900 text-muted-foreground">
                  {p.allInstances.length === 0 ? "Carregando instâncias…" : "Selecione uma instância…"}
                </option>
                {p.allInstances.map((inst) => (
                  <option key={inst} value={inst} className="bg-neutral-900">{inst}</option>
                ))}
              </select>
              {p.vinculoInstance && !p.allInstances.includes(p.vinculoInstance) && (
                <p className="text-[9px] text-orange-400 mt-1 px-1">
                  ⚠ Instância salva (<code>{p.vinculoInstance}</code>) ainda não apareceu na lista — aguarde ou crie em /whatsapp.
                </p>
              )}
              <p className="text-[9px] text-muted-foreground mt-1 px-1">
                Cada agente usa <strong>uma</strong> instância. Trocar aqui transfere o vínculo.
              </p>
            </div>

            {/* Buffer de mensagens */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-primary">Agrupamento de Mensagens</label>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{p.messageBufferSeconds}s</span>
              </div>
              <NumberInput
                min={0}
                max={30}
                fallback={0}
                value={p.messageBufferSeconds}
                onChange={(n) => p.setMessageBufferSeconds(n)}
                className="w-full bg-white/5 border-primary/20 text-white h-12 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-primary/50"
                placeholder="Ex: 5"
              />
              <p className="text-[9px] text-muted-foreground mt-1 px-1">
                Tempo em segundos que a Sarah aguarda novas mensagens do mesmo contato antes de responder tudo de uma vez. Use 0 para desativar.
              </p>
            </div>

            {/* Humanizar */}
            <ToggleRow
              label="Humanizar Respostas (Picotar)"
              labelColor="text-[#00ffcc]"
              color="emerald"
              checked={p.humanizeMessages}
              onChange={p.setHumanizeMessages}
              hint="Divide respostas longas em várias mensagens menores e simula tempo de digitação entre elas."
            />

            {/* Web Search MCP */}
            <ToggleRow
              label="Pesquisar na internet (MCP)"
              labelColor="text-cyan-400"
              color="cyan"
              checked={p.webSearchEnabled}
              onChange={p.setWebSearchEnabled}
              hint={<>Habilita a tool <code className="text-cyan-300">web_search</code> (DuckDuckGo, sem chave). Funciona em qualquer modelo. Use quando precisar de fato/dado atualizado.</>}
            />

            {/* Modo de Raciocínio UNIVERSAL — funciona em todos os modelos */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-amber-400">Modo de Raciocínio (custo) — vale pra TODOS os modelos</label>
              <select
                value={p.reasoningMode}
                onChange={(e) => p.setReasoningMode(Number(e.target.value) as 0 | 1 | 2)}
                className="w-full bg-white/5 border border-amber-400/20 text-white h-12 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
              >
                <option value={0} className="bg-neutral-900 text-white">Econômico — sem raciocínio extra (recomendado p/ SDR)</option>
                <option value={1} className="bg-neutral-900 text-white">Equilibrado — pouco raciocínio (tools/agendamento)</option>
                <option value={2} className="bg-neutral-900 text-white">Intenso — raciocínio total (casos complexos, mais caro)</option>
              </select>
              <p className="text-[11px] text-white/40 leading-relaxed">
                Controla quanto a IA &quot;pensa&quot; antes de responder — <strong>em qualquer modelo</strong> (GPT, Claude, Gemini, DeepSeek). No modo <strong>Econômico</strong> responde direto (gasta menos token, ideal pra SDR). Suba pra <strong>Equilibrado</strong> se usar agendamento/tools, ou <strong>Intenso</strong> em casos complexos. Modelos sem suporte ignoram.
              </p>
            </div>

            {/* Lead Intelligence — por agente */}
            <ToggleRow
              label="Inteligência de Cliente"
              labelColor="text-purple-400"
              color="purple"
              checked={p.leadIntelligenceEnabled}
              onChange={p.setLeadIntelligenceEnabled}
              hint={<>Antes de cada interação, a IA gera um <strong>briefing do cliente</strong> (dores, abordagem, decisor, alertas) e usa no contexto. Custa tokens extra — ative só nos agentes que precisam de análise profunda.</>}
            />

            {/* Função */}
            <Field label="Função Principal" copy={p.funcaoAgente}>
              <Textarea value={p.funcaoAgente} onChange={(e) => p.setFuncaoAgente(e.target.value)} className="bg-white/5 border-white/10 h-[100px] resize-none rounded-xl text-sm" />
            </Field>
          </div>
        </div>

        {/* Personalidade + Tom */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Field label="Personalidade" copy={p.personalidadeAgente}>
            <Textarea value={p.personalidadeAgente} onChange={(e) => p.setPersonalidadeAgente(e.target.value)} className="bg-white/5 border-white/10 resize-none h-24 rounded-xl text-sm p-4" />
          </Field>
          <Field label="Tom de Voz" copy={p.tomAgente}>
            <Textarea value={p.tomAgente} onChange={(e) => p.setTomAgente(e.target.value)} className="bg-white/5 border-white/10 resize-none h-24 rounded-xl text-sm p-4" />
          </Field>
        </div>

        <SaveButton
          label="Salvar Identidade"
          onSave={p.saveIdentity}
          disabled={p.savingConfig}
          className="mt-4"
        />

        {/* ========= SUBSEÇÃO: GOOGLE CALENDAR ========= */}
        <div className="pt-4 border-t border-white/5 space-y-4">
          <div className="flex justify-between items-center bg-black/20 p-4 border border-white/5 rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 text-blue-400 rounded-xl"><Settings className="w-4 h-4" /></div>
              <div>
                <h4 className="font-bold text-sm text-white">Google Calendar (MCP Tool)</h4>
                <p className="text-xs text-muted-foreground mt-0.5">Permite a IA agendar reuniões ativamente.</p>
              </div>
            </div>
            <Toggle
              checked={p.calendarEnabled}
              onCheckedChange={p.setCalendarEnabled}
              color="blue"
              size="lg"
              aria-label="Habilitar Google Calendar"
            />
          </div>

          {p.calendarEnabled && (
            <div className="bg-white/5 p-4 rounded-xl border border-white/10 animate-in fade-in duration-300 space-y-4">
              {/* OAuth JSON */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">OAuth Web Client JSON</label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={p.onTestGoogle}
                      disabled={p.testingGoogle}
                      className="text-[10px] font-bold px-2 py-1 rounded-md border border-blue-400/30 text-blue-300 hover:bg-blue-400/10 disabled:opacity-50 transition-colors"
                      title="Valida a credencial, salva e abre o Google para autorizar a conexão"
                    >
                      {p.testingGoogle ? "Testando..." : "Testar conexão"}
                    </button>
                    <CopyButton text={p.googleJson} />
                  </div>
                </div>
                <Textarea
                  value={p.googleJson}
                  onChange={(e) => p.setGoogleJson(e.target.value)}
                  placeholder='{"web": {"client_id": "...", "client_secret": "..."}}'
                  className="h-24 bg-black/40 border-white/10 text-xs font-mono text-white/70"
                />
              </div>

              {/* Duração padrão */}
              <div className="space-y-2 pt-4 border-t border-white/5">
                <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">Duração padrão da reunião</label>
                <div className="flex gap-2 items-center">
                  <NumberInput
                    min={5}
                    max={480}
                    fallback={30}
                    value={p.calendarDefaultDuration}
                    onChange={(n) => p.setCalendarDefaultDuration(n)}
                    className="bg-black/40 border-white/10 text-sm h-10 w-28 font-mono"
                  />
                  <span className="text-[10px] text-muted-foreground uppercase font-bold">minutos por evento</span>
                </div>
                <p className="text-[9px] text-muted-foreground">A IA usa esse valor por padrão. Cliente pode pedir outra duração na conversa.</p>
              </div>

              {/* Gerar Meet */}
              <div className="flex items-center justify-between gap-3 p-2 bg-black/30 rounded-lg border border-white/5">
                <div>
                  <p className="text-[11px] font-bold text-white">Gerar link do Google Meet</p>
                  <p className="text-[9px] text-muted-foreground">Cria sala virtual automaticamente em todo evento</p>
                </div>
                <Toggle
                  checked={p.calendarGenerateMeet}
                  onCheckedChange={p.setCalendarGenerateMeet}
                  color="blue"
                  size="md"
                  aria-label="Gerar link do Google Meet"
                />
              </div>

              {/* Enviar link do Meet ao cliente — só faz sentido se gera Meet */}
              {p.calendarGenerateMeet && (
                <div className="flex items-center justify-between gap-3 p-2 bg-black/30 rounded-lg border border-white/5">
                  <div>
                    <p className="text-[11px] font-bold text-white">Enviar o link do Meet ao cliente</p>
                    <p className="text-[9px] text-muted-foreground">Ao agendar, a IA manda o link da reunião direto no WhatsApp do cliente</p>
                  </div>
                  <Toggle
                    checked={p.calendarSendMeetLink}
                    onCheckedChange={p.setCalendarSendMeetLink}
                    color="blue"
                    size="md"
                    aria-label="Enviar link do Meet ao cliente"
                  />
                </div>
              )}

              {/* Campos opcionais */}
              <div className="space-y-2 pt-4 border-t border-white/5">
                <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">Perguntas diretas ao cliente</label>
                <p className="text-[9px] text-muted-foreground -mt-1">Marque quais informações a IA deve <strong>perguntar diretamente</strong> ao cliente antes de agendar.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {CALENDAR_FIELDS.map((f) => {
                    const checked = !!p.calendarOptionalFields[f.key];
                    return (
                      <label
                        key={f.key}
                        onClick={() => p.setCalendarOptionalFields((prev) => ({ ...prev, [f.key]: !checked }))}
                        className={cn(
                          "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all",
                          checked ? "bg-blue-500/10 border-blue-500/30" : "bg-black/20 border-white/5 hover:border-white/20"
                        )}
                      >
                        <div className={cn("w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5", checked ? "bg-blue-500 border-blue-500" : "border-white/20")}>
                          {checked && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="min-w-0">
                          <p className={cn("text-[11px] font-bold", checked ? "text-blue-200" : "text-white/80")}>{f.label}</p>
                          <p className="text-[9px] text-muted-foreground">{f.hint}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {/* Captura automática */}
                <div className="mt-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15 space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Captura automática (sem perguntar)</p>
                  {CALENDAR_AUTO_CAPTURE_FIELDS.map((item) => {
                    const on = p.calendarAutoCapture[item.key];
                    // Label dinâmico pro "necessidade" — usa o customizado se existir
                    const displayLabel = item.key === "necessidade" && p.calendarAutoCapture.necessidade_label
                      ? p.calendarAutoCapture.necessidade_label
                      : item.label;
                    return (
                      <div key={item.key} className="flex items-center justify-between gap-3 py-1">
                        <div className="min-w-0">
                          <p className={cn("text-[11px] font-bold", on ? "text-emerald-200" : "text-muted-foreground")}>{displayLabel}</p>
                          <p className="text-[9px] text-emerald-100/50">{item.desc}</p>
                        </div>
                        <Toggle
                          checked={on}
                          onCheckedChange={(next) => p.setCalendarAutoCapture((prev: any) => ({ ...prev, [item.key]: next }))}
                          color="emerald"
                          size="md"
                          aria-label={`Captura automática: ${displayLabel}`}
                        />
                      </div>
                    );
                  })}

                  {/* Customizar nome do campo "necessidade" — adapta ao nicho */}
                  {p.calendarAutoCapture.necessidade && (
                    <div className="pt-2 mt-2 border-t border-emerald-500/15 space-y-2">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-emerald-300/80">Como você chama isso no seu negócio?</p>
                        <p className="text-[9px] text-emerald-100/50 mt-0.5">
                          Esse texto vira o "tipo de serviço" no Google Calendar + no card do /calendario.
                          A IA usa pra entender o que perguntar e inferir.
                        </p>
                      </div>

                      {/* Presets de nicho — clique pra popular */}
                      <div className="flex flex-wrap gap-1">
                        {NICHE_PRESETS.map((preset) => {
                          const active = (p.calendarAutoCapture.necessidade_label || "Dor / Necessidade") === preset.nec_label;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => p.setCalendarAutoCapture((prev: any) => ({
                                ...prev,
                                necessidade_label: preset.nec_label,
                              }))}
                              className={cn(
                                "text-[9px] font-bold px-2 py-1 rounded-md border transition",
                                active
                                  ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-100"
                                  : "bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                              )}
                              title={preset.hint}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>

                      {/* Input livre — sobrescreve qualquer preset */}
                      <input
                        type="text"
                        value={p.calendarAutoCapture.necessidade_label || ""}
                        onChange={(e) => p.setCalendarAutoCapture((prev: any) => ({
                          ...prev,
                          necessidade_label: e.target.value,
                        }))}
                        placeholder="Dor / Necessidade (default)"
                        className="w-full h-8 px-2 text-xs bg-black/30 border border-white/10 rounded text-emerald-100 placeholder:text-muted-foreground/50 focus:outline-none focus:border-emerald-500/30"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Preview do que vai pro prompt */}
              <div className="space-y-2 pt-4 border-t border-white/5">
                <label className="text-[10px] font-black uppercase tracking-widest text-purple-400">Regras auto-injetadas no prompt</label>
                <div className="bg-black/40 rounded-lg p-3 border border-purple-500/20 space-y-1.5">
                  <p className="text-[10px] text-purple-200/80 font-mono leading-relaxed">
                    • Quando o cliente quiser marcar/agendar, SEMPRE chame <code className="text-purple-300">check_google_calendar_availability</code> antes de sugerir horários.
                    {Object.values(p.calendarOptionalFields).some(Boolean) && (
                      <> Antes de agendar, OBTENHA: {Object.entries(p.calendarOptionalFields).filter(([, v]) => v).map(([k]) => k).join(", ")}.</>
                    )}
                  </p>
                  <p className="text-[10px] text-purple-200/80 font-mono leading-relaxed">
                    • Para CRIAR o evento, chame <code className="text-purple-300">schedule_google_calendar</code> com duração padrão de <strong>{p.calendarDefaultDuration} min</strong>.
                    {p.calendarGenerateMeet && " Link do Meet será gerado automaticamente."}
                  </p>
                </div>
                <p className="text-[9px] text-muted-foreground italic">Você não precisa escrever isso no prompt — o sistema injeta automaticamente.</p>
              </div>

              {/* ========= SCHEDULER: lembretes automáticos + auto-promote kanban ========= */}
              <div className="pt-4 border-t border-white/5 space-y-4">
                <div className="flex justify-between items-center bg-gradient-to-r from-emerald-500/5 to-blue-500/5 p-3 border border-emerald-500/20 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg text-base">🗓️</div>
                    <div>
                      <h4 className="font-bold text-sm text-white">Agente de Agendamento</h4>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Manda lembretes automáticos e move o cliente pro estágio "atendido" depois do horário</p>
                    </div>
                  </div>
                  <Toggle
                    checked={p.isScheduler}
                    onCheckedChange={p.setIsScheduler}
                    color="green"
                    size="md"
                    aria-label="Ativar agente de agendamento"
                  />
                </div>

                {p.isScheduler && (
                  <div className="bg-black/30 p-4 rounded-xl border border-emerald-500/10 space-y-4 animate-in fade-in duration-300">
                    {/* Lembretes */}
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Lembretes automáticos</label>
                      <p className="text-[9px] text-muted-foreground mt-0.5">A IA manda essas mensagens X minutos antes do agendamento. Use variáveis abaixo.</p>
                      <div className="space-y-2 mt-2">
                        {p.reminders.map((r, idx) => (
                          <div key={idx} className="bg-black/40 border border-white/5 rounded-lg p-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <NumberInput
                                min={1}
                                max={43200}
                                fallback={60}
                                value={r.offset_minutes}
                                onChange={(n) => p.setReminders((prev: any[]) => prev.map((x, i) => i === idx ? { ...x, offset_minutes: n } : x))}
                                className="bg-black/60 border-white/10 text-xs h-8 w-24 font-mono"
                              />
                              <span className="text-[10px] text-muted-foreground uppercase font-bold">min antes</span>
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                ({r.offset_minutes >= 1440 ? `${Math.round(r.offset_minutes / 1440)}d` :
                                  r.offset_minutes >= 60 ? `${Math.round(r.offset_minutes / 60)}h` : `${r.offset_minutes}min`})
                              </span>
                              <button
                                onClick={() => p.setReminders((prev: any[]) => prev.filter((_, i) => i !== idx))}
                                className="text-red-400/70 hover:text-red-400 text-[10px] font-bold uppercase"
                                title="Remover este lembrete"
                              >Remover</button>
                            </div>
                            <Textarea
                              value={r.message}
                              onChange={(e) => p.setReminders((prev: any[]) => prev.map((x, i) => i === idx ? { ...x, message: e.target.value } : x))}
                              className="text-xs bg-black/60 border-white/5 min-h-[60px] resize-none"
                              placeholder="Oi {nome}! Lembrete: amanhã às {hora_agendamento} ..."
                            />
                          </div>
                        ))}
                        <button
                          onClick={() => p.setReminders((prev: any[]) => [...prev, { offset_minutes: 30, message: "Oi {nome}! Lembrete do seu agendamento às {hora_agendamento}." }])}
                          className="w-full py-2 rounded-lg border border-dashed border-emerald-500/30 text-[10px] uppercase font-bold text-emerald-400 hover:bg-emerald-500/5"
                        >
                          + Adicionar lembrete
                        </button>
                      </div>

                      {/* Variáveis disponíveis */}
                      <div className="mt-3">
                        <p className="text-[9px] uppercase font-bold text-muted-foreground mb-1">Variáveis disponíveis (clique pra copiar)</p>
                        <div className="flex flex-wrap gap-1">
                          {["{nome}", "{nome_negocio}", "{ramo_negocio}", "{telefone}", "{hora_agendamento}", "{data_agendamento}", "{servico}", "{titulo}", "{meet_link}", "{local}"].map(v => (
                            <button
                              key={v}
                              onClick={() => { navigator.clipboard.writeText(v); }}
                              className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 border border-white/10 hover:bg-emerald-500/10 hover:border-emerald-500/30 text-emerald-300 transition"
                              title={`Copiar ${v}`}
                            >{v}</button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Auto-promote kanban — De [coluna] → Para [coluna] */}
                    <div className="pt-3 border-t border-white/5">
                      <label className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Auto-mover cliente no kanban</label>
                      <p className="text-[9px] text-muted-foreground mt-0.5">Depois que o agendamento termina, move o cliente de uma coluna pra outra do SEU kanban.</p>
                      <div className="flex gap-2 items-center mt-2">
                        <NumberInput
                          min={0}
                          max={1440}
                          fallback={30}
                          value={p.autoPromoteAfter}
                          onChange={(n) => p.setAutoPromoteAfter(n)}
                          className="bg-black/40 border-white/10 text-sm h-9 w-24 font-mono"
                        />
                        <span className="text-[10px] text-muted-foreground uppercase font-bold">min após o agendamento</span>
                      </div>

                      {/* Pausa pós-agendamento: silencia a IA pra ESTE contato por
                          X minutos depois de marcar. Evita bombardear o cliente
                          e dá uma janela ao atendente humano. 0 = não pausa. */}
                      <div className="mt-3 p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04]">
                        <label className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Silenciar IA após agendar</label>
                        <p className="text-[9px] text-muted-foreground mt-0.5 leading-relaxed">
                          Depois que o agente marca com sucesso, a IA <strong>para de responder este número</strong> pelo tempo abaixo (depois volta sozinha). Dá respiro pro cliente e espaço pro humano assumir. <strong>0 = não pausa.</strong>
                        </p>
                        <div className="flex gap-2 items-center mt-2">
                          <NumberInput
                            min={0}
                            max={10080}
                            fallback={120}
                            value={p.pauseAfterSchedule}
                            onChange={(n) => p.setPauseAfterSchedule(n)}
                            className="bg-black/40 border-white/10 text-sm h-9 w-24 font-mono"
                          />
                          <span className="text-[10px] text-muted-foreground uppercase font-bold">minutos (padrão 120 = 2h)</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-3">
                        <div>
                          <label className="text-[9px] uppercase font-bold text-muted-foreground">De (coluna de origem)</label>
                          <select
                            value={p.autoPromoteFrom}
                            onChange={(e) => p.setAutoPromoteFrom(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 text-white h-9 rounded-lg text-xs px-2 mt-1 focus:outline-none"
                          >
                            <option value="" className="bg-neutral-900">Qualquer coluna</option>
                            {p.kanbanColumns.map((c) => (
                              <option key={c.status_key} value={c.status_key} className="bg-neutral-900">{c.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[9px] uppercase font-bold text-muted-foreground">Para (coluna de destino)</label>
                          <select
                            value={p.autoPromoteTo}
                            onChange={(e) => p.setAutoPromoteTo(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 text-white h-9 rounded-lg text-xs px-2 mt-1 focus:outline-none"
                          >
                            <option value="" className="bg-neutral-900">Automático (estágio "atendido/fechado")</option>
                            {p.kanbanColumns.map((c) => (
                              <option key={c.status_key} value={c.status_key} className="bg-neutral-900">{c.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-1.5">
                        Cada nicho tem colunas próprias (comercial ≠ clínica) — escolha as do seu kanban.
                        {p.kanbanColumns.length === 0 && " ⚠ Nenhuma coluna carregada — configure o kanban primeiro."}
                      </p>
                    </div>

                    {/* Notificar dono */}
                    <div className="pt-3 border-t border-white/5 space-y-2">
                      <div className="flex items-center justify-between gap-3 p-2 bg-black/40 rounded-lg border border-white/5">
                        <div>
                          <p className="text-[11px] font-bold text-white">Avisar o dono no WhatsApp</p>
                          <p className="text-[9px] text-muted-foreground">Manda mensagem pro seu número quando a IA agendar algo novo</p>
                        </div>
                        <Toggle
                          checked={p.notifyOwner}
                          onCheckedChange={p.setNotifyOwner}
                          color="green"
                          size="md"
                          aria-label="Notificar dono"
                        />
                      </div>
                      {p.notifyOwner && (
                        <input
                          type="text"
                          value={p.ownerPhone}
                          onChange={(e) => p.setOwnerPhone(e.target.value)}
                          placeholder="5511999998888 (com DDD, sem +)"
                          className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder:text-muted-foreground/40"
                        />
                      )}
                    </div>

                    {/* Resumo do atendimento por IA pro dono */}
                    <div className="pt-3 border-t border-white/5 space-y-2">
                      <div className="flex items-center justify-between gap-3 p-2 bg-black/40 rounded-lg border border-white/5">
                        <div>
                          <p className="text-[11px] font-bold text-white">Resumo do atendimento por IA pro dono</p>
                          <p className="text-[9px] text-muted-foreground">
                            Quando a IA agenda, cancela ou remarca, ela lê a conversa com o cliente e manda um resumo no seu WhatsApp
                          </p>
                        </div>
                        <Toggle
                          checked={p.ownerSummaryEnabled}
                          onCheckedChange={p.setOwnerSummaryEnabled}
                          color="green"
                          size="md"
                          aria-label="Resumo IA pro dono"
                        />
                      </div>
                      {p.ownerSummaryEnabled && (
                        <div className="space-y-2 animate-in fade-in duration-200">
                          <p className="text-[9px] text-amber-300/90">
                            ⚠ O resumo é enviado pro número do "Avisar o dono" acima — preencha-o.
                          </p>
                          <div>
                            <label className="text-[9px] uppercase font-bold text-muted-foreground">
                              Prompt do resumo — descreva o que VOCÊ quer saber
                            </label>
                            <Textarea
                              value={p.ownerSummaryPrompt}
                              onChange={(e) => p.setOwnerSummaryPrompt(e.target.value)}
                              placeholder={"Ex (comercial): Resuma o lead, a dor dele, objeções levantadas, orçamento citado e o que ficou combinado.\nEx (salão): Diga o serviço escolhido, profissional, horário e observações da cliente."}
                              className="text-xs bg-black/60 border-white/5 min-h-[90px] resize-none mt-1"
                            />
                            <p className="text-[9px] text-muted-foreground mt-1">
                              Cada nicho precisa de um resumo diferente — escreva o seu. Em branco = resumo padrão.
                            </p>
                          </div>
                          {p.isAdmin ? (
                            <div>
                              <label className="text-[9px] uppercase font-bold text-muted-foreground">Modelo de IA do resumo</label>
                              <select
                                value={p.ownerSummaryModel}
                                onChange={(e) => p.setOwnerSummaryModel(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 text-white h-9 rounded-lg text-xs px-2 mt-1 focus:outline-none"
                              >
                                <option value="" className="bg-neutral-900">Padrão da conta</option>
                                {p.ownerSummaryModel && !p.modelOptions.some((m) => m.id === p.ownerSummaryModel) && (
                                  <option value={p.ownerSummaryModel} className="bg-neutral-900">{p.ownerSummaryModel} (salvo)</option>
                                )}
                                <ModelOptions models={p.modelOptions as any} />
                              </select>
                              <p className="text-[9px] text-muted-foreground mt-1">Só o admin escolhe o modelo. Cliente comum usa o padrão da conta.</p>
                            </div>
                          ) : (
                            <p className="text-[9px] text-muted-foreground">Modelo de IA do resumo: padrão da conta (definido pelo admin).</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <SaveButton
                label="Salvar Configurações de Agenda"
                onSave={p.saveCalendarConfig}
              />
            </div>
          )}
        </div>

        {/* ========= SUBSEÇÃO: WEBHOOK ========= */}
        <div className="pt-4 border-t border-white/5 space-y-6">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-[#00ffcc]">Webhook do Agente (Cole na Evolution API v2)</label>
            <div className="flex gap-2">
              <Button
                onClick={p.onSyncWebhook}
                className="h-7 px-3 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 text-[9px] font-black uppercase tracking-widest"
              >
                Sincronizar Agora
              </Button>
              <CopyButton text={p.webhookUrl} label="Copiar" />
            </div>
          </div>
          <Input readOnly value={p.webhookUrl} className="bg-black/40 border-white/10 text-xs font-mono h-12 pr-12 w-full" />

          <WebhookGuide webhookUrl={p.webhookUrl} />
        </div>
      </section>

      {/* ========= SEÇÃO 2: PROMPT PRINCIPAL ========= */}
      <section className="glass-card p-6 md:p-8 rounded-[2rem] border-white/10 space-y-5 bg-white/[0.02]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-black tracking-tight">Prompt Principal</h3>
            <span className="text-[10px] font-mono text-muted-foreground bg-white/5 border border-white/10 rounded-md px-2 py-0.5">
              {p.prompt.length.toLocaleString("pt-BR")} chars · {p.prompt.split(/\s+/).filter(Boolean).length} palavras
            </span>
          </div>
          <div className="flex items-center gap-2">
            <CopyButton text={p.prompt} label="Copiar" />
            <SaveButton
              label="Salvar Prompt"
              onSave={p.savePrompt}
              disabled={p.savingConfig}
              variant="subtle"
              size="sm"
              width="auto"
            />
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground -mt-2">
          Clique ou arraste qualquer chip pra dentro do editor. As variáveis são substituídas em runtime.
        </p>

        {/* Chips: variáveis dinâmicas */}
        <details open className="group rounded-xl bg-cyan-500/5 border border-cyan-500/15 overflow-hidden">
          <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-cyan-500/[0.08] transition list-none">
            <div className="flex items-center gap-2">
              <span className="text-cyan-400 transition-transform group-open:rotate-90 inline-block w-3 text-center">▶</span>
              <p className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Variáveis dinâmicas</p>
              <span className="text-[9px] font-mono text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">{PROMPT_VARIABLES.length}</span>
            </div>
            <p className="text-[9px] text-muted-foreground italic hidden md:block">Trocadas em runtime — saudação muda com a hora</p>
          </summary>
          <div className="flex flex-wrap gap-2 p-3 pt-0">
            {PROMPT_VARIABLES.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => p.insertVariable(v.key)}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 hover:scale-[1.03] active:scale-95 transition-all cursor-grab active:cursor-grabbing"
                title={v.hint}
              >
                <span className="text-[11px] font-bold text-cyan-100">{v.label}</span>
                <code className="text-[9px] font-mono text-cyan-300/70">{`{{${v.key}}}`}</code>
              </button>
            ))}
          </div>
        </details>

        {/* Chips: KB */}
        {p.knowledge.length > 0 && (
          <details open className="group rounded-xl bg-purple-500/5 border border-purple-500/15 overflow-hidden">
            <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-purple-500/[0.08] transition list-none">
              <div className="flex items-center gap-2">
                <span className="text-purple-400 transition-transform group-open:rotate-90 inline-block w-3 text-center">▶</span>
                <p className="text-[10px] font-black uppercase tracking-widest text-purple-400">Variáveis de conhecimento</p>
                <span className="text-[9px] font-mono text-purple-300/70 bg-purple-500/10 px-1.5 py-0.5 rounded">{p.knowledge.length}</span>
              </div>
              <p className="text-[9px] text-muted-foreground italic hidden md:block">Clique pra inserir no cursor (ou arraste)</p>
            </summary>
            <div className="px-3 pb-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                {p.knowledge.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => p.insertKbVariable(k.title)}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", `{{kb:${k.title}}}`)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 hover:scale-[1.03] active:scale-95 transition-all cursor-grab active:cursor-grabbing"
                    title={`Insere {{kb:${k.title}}} no prompt`}
                  >
                    <Book className="w-3 h-3 text-purple-300" />
                    <span className="text-[11px] font-bold text-purple-100">{k.title}</span>
                    <code className="text-[9px] font-mono text-purple-300/70">{`{{kb}}`}</code>
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-purple-200/60 leading-relaxed">
                Onde aparecer <code className="bg-black/30 px-1 rounded text-purple-300">{`{{kb:Título}}`}</code>, o sistema substitui por uma regra que faz a IA chamar
                <span className="font-mono text-purple-300"> search_knowledge_base</span>. KBs que você não inserir manualmente continuam ativas (auto-injetadas no topo).
              </p>
            </div>
          </details>
        )}

        {/* Editor */}
        <div className="rounded-2xl bg-[#0a0a0a] border border-white/10 overflow-hidden shadow-inner">
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-white/5 bg-white/[0.02]">
            <p className="text-[10px] font-black uppercase tracking-widest text-white/60">Editor — prompt cru</p>
            <p className="text-[9px] text-muted-foreground font-mono">arraste chips ou digite • redimensione pelo canto</p>
          </div>
          <Textarea
            ref={p.promptRef}
            value={p.prompt}
            onChange={(e) => p.setPrompt(e.target.value)}
            className="min-h-[200px] sm:min-h-[320px] max-h-[60vh] font-mono text-sm bg-transparent border-0 rounded-none p-5 leading-relaxed resize-y focus:ring-0 focus:border-0 focus-visible:ring-0"
          />
        </div>

        {/* Pré-visualização final */}
        <PromptPreview
          rawPrompt={p.prompt}
          sample={p.previewSample}
          setSample={p.setPreviewSample}
          knowledge={p.knowledge}
          open={p.previewOpen}
          setOpen={p.setPreviewOpen}
          leads={p.previewLeads}
          leadsLoading={p.previewLeadsLoading}
          onOpenLeadPicker={() => { if (p.previewLeads.length === 0) p.loadPreviewLeads(); }}
          selectedLeadId={p.previewSelectedLeadId}
          onSelectLead={p.applyLeadToSample}
          leadQuery={p.previewLeadQuery}
          setLeadQuery={p.setPreviewLeadQuery}
        />
      </section>

      {/* ========= SEÇÃO 3: BASE DE CONHECIMENTO ========= */}
      <section className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-black tracking-tight">Base de Conhecimento</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Funciona como uma <strong>tool</strong>: a IA consulta só quando o cliente perguntar sobre o tópico — não sobrecarrega o prompt.
            </p>
          </div>
          <Button onClick={() => p.setShowNovoK(!p.showNovoK)} variant="outline" className="h-11 bg-primary/10 border-primary/20 text-primary hover:bg-primary/20 rounded-xl px-6 font-bold text-xs uppercase tracking-widest">
            <Plus className="w-4 h-4 mr-2" /> Nova Base
          </Button>
        </div>

        {p.knowledge.length > 0 && (
          <div className="space-y-3">
            <div className="p-4 rounded-2xl bg-purple-500/5 border border-purple-500/15 space-y-2">
              <div className="flex items-center gap-2">
                <Wrench className="w-3.5 h-3.5 text-purple-400" />
                <p className="text-[10px] font-black uppercase tracking-widest text-purple-400">Como a IA usa essa base</p>
              </div>
              <p className="text-[11px] text-purple-100/70 leading-relaxed">
                Cada item abaixo vira um <strong>tópico-gatilho</strong>. Quando o cliente perguntar sobre ele, a IA chama
                a tool <code className="text-purple-300 bg-black/30 px-1 rounded">search_knowledge_base</code> com a query
                do tópico — assim ela só lê o conteúdo na hora certa, sem gastar tokens à toa.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20 space-y-2.5">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-blue-400" />
                <p className="text-xs font-black uppercase tracking-wider text-blue-400">
                  📷 Como Vincular Fotos aos Produtos (Anti-Alucinação)
                </p>
              </div>
              <p className="text-[11px] text-blue-200/80 leading-relaxed">
                Para cadastrar produtos (ex: <strong>iPhone 15, Galaxy S24, Celulares</strong>) e garantir que a IA envie as fotos reais dos aparelhos com preço correto via WhatsApp, use o botão <strong>&quot;Anexar Foto de Produto&quot;</strong> ou insira a tag <code className="text-blue-300 bg-black/40 px-1 py-0.5 rounded">[IMAGEM: https://...]</code>.
              </p>
              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-1 font-mono text-[10px] text-blue-200/90">
                <p className="font-bold text-blue-400">Exemplo para Tópico &quot;iPhone 15&quot;:</p>
                <p>• iPhone 15 128GB - R$ 4.599 [IMAGEM: https://sua-cdn.com/iphone15.jpg]</p>
                <p>• iPhone 15 Pro 128GB - R$ 5.899 [IMAGEM: https://sua-cdn.com/iphone15pro.jpg]</p>
                <p>• iPhone 15 Pro Max 256GB - R$ 6.999 [IMAGEM: https://sua-cdn.com/iphone15promax.jpg]</p>
              </div>
            </div>
          </div>
        )}

        {p.showNovoK && (
          <div className="p-6 bg-white/5 border border-white/10 rounded-2xl space-y-5">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título da Base / Gatilho</label>
              <Input value={p.novoKTitle} onChange={(e) => p.setNovoKTitle(e.target.value)} placeholder="Ex: iPhone 15, Catálogo de Celulares, Preços..." className="bg-black/50 border-white/10" />
              <p className="text-[9px] text-muted-foreground">Use o nome do produto ou palavra-chave. Quando o cliente perguntar disso, a IA lê este documento.</p>
            </div>

            {/* Construtor Estruturado de Catálogo */}
            <ProductCatalogBuilder
              onAppendCatalog={(formattedText) => {
                p.setNovoKContent(p.novoKContent ? `${p.novoKContent}\n\n${formattedText}` : formattedText);
              }}
            />

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black uppercase tracking-widest text-primary">Conteúdo Final do Documento</label>
                <label className="inline-flex items-center gap-1.5 text-[10px] font-bold text-blue-400 hover:text-blue-300 cursor-pointer bg-blue-500/10 border border-blue-500/20 px-2.5 py-1 rounded-lg transition-colors">
                  {uploadingImg ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  Anexar Foto Avulsa
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploadingImg}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploadingImg(true);
                      const url = await uploadImageToStorage(file);
                      setUploadingImg(false);
                      if (url) {
                        p.setNovoKContent(p.novoKContent ? `${p.novoKContent}\n[IMAGEM: ${url}]` : `[IMAGEM: ${url}]`);
                        toast.success("Foto do produto anexada e vinculada!");
                      }
                    }}
                  />
                </label>
              </div>
              <Textarea value={p.novoKContent} onChange={(e) => p.setNovoKContent(e.target.value)} placeholder="O conteúdo gerado do catálogo ou texto livre aparecerá aqui..." className="bg-black/50 border-white/10 h-44 font-mono text-xs leading-relaxed" />
            </div>
            <SaveButton label="Adicionar ao Conhecimento" onSave={p.salvarNovoKnowledge} />
          </div>
        )}

        {!p.showNovoK && p.knowledge.length === 0 && (
          <EmptyState
            icon={Book}
            title="Sem base de conhecimento ainda"
            description={
              <>
                Adicione documentos que a IA pode consultar quando precisar — <strong>catálogo de celulares, preços, fotos de produtos, garantias</strong>.
                Ela só lê quando o cliente perguntar do tópico, então não gasta tokens à toa nem inventa resposta.
              </>
            }
            action={
              <Button
                onClick={() => p.setShowNovoK(true)}
                className="glow-primary h-10 px-5 font-bold text-xs uppercase tracking-widest gap-2"
              >
                <Plus className="w-4 h-4" /> Criar primeira base
              </Button>
            }
          />
        )}

        <div className="space-y-3">
          {p.knowledge.map((k) => (
            <div key={k.id} className="glass-panel border-white/10 rounded-2xl p-4 hover:bg-white/5 transition-colors group bg-white/[0.01]">
              {p.editKId === k.id ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título</label>
                    <Input value={p.editKTitle} onChange={(e) => p.setEditKTitle(e.target.value)} className="bg-black/50 border-white/10" />
                  </div>

                  {/* Construtor Estruturado de Catálogo na Edição */}
                  <ProductCatalogBuilder
                    onAppendCatalog={(formattedText) => {
                      p.setEditKContent(p.editKContent ? `${p.editKContent}\n\n${formattedText}` : formattedText);
                    }}
                  />

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black uppercase tracking-widest text-primary">Conteúdo</label>
                      <label className="inline-flex items-center gap-1.5 text-[10px] font-bold text-blue-400 hover:text-blue-300 cursor-pointer bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-md transition-colors">
                        {uploadingImg ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                        Anexar Foto Avulsa
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={uploadingImg}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            setUploadingImg(true);
                            const url = await uploadImageToStorage(file);
                            setUploadingImg(false);
                            if (url) {
                              p.setEditKContent(p.editKContent ? `${p.editKContent}\n[IMAGEM: ${url}]` : `[IMAGEM: ${url}]`);
                              toast.success("Foto do produto anexada ao conteúdo!");
                            }
                          }}
                        />
                      </label>
                    </div>
                    <Textarea value={p.editKContent} onChange={(e) => p.setEditKContent(e.target.value)} className="bg-black/50 border-white/10 h-44 font-mono text-xs leading-relaxed" />
                  </div>
                  <div className="flex gap-2">
                    <SaveButton label="Salvar alterações" onSave={p.salvarEdicaoKnowledge} className="flex-1" />
                    <Button onClick={p.cancelarEdicaoKnowledge} variant="outline" className="gap-2 h-11 rounded-xl"><X className="w-4 h-4" /> Cancelar</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-4 min-w-0">
                      <div className="p-3 bg-blue-500/10 text-blue-400 rounded-xl shrink-0"><Book className="w-5 h-5" /></div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-sm truncate">{k.title}</h4>
                          {/\[IMAGEM:\s*https?:\/\/[^\s\]]+\]/i.test(k.content || "") && (
                            <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 border border-blue-500/30 px-1.5 py-0.5 text-[9px] font-bold text-blue-400 shrink-0">
                              <ImageIcon className="w-2.5 h-2.5" /> Foto Vinculada
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{(k.content || "").substring(0, 80)}...</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button onClick={() => p.iniciarEdicaoKnowledge(k)} size="icon" variant="ghost" className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-lg" title="Editar">
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button onClick={() => p.deletarKnowledge(k.id)} size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg" title="Excluir">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-white/5">
                    <p className="text-[9px] font-black uppercase tracking-widest text-purple-400 mb-1">Como é usada</p>
                    <code className="block text-[10px] text-purple-200/80 font-mono bg-black/30 p-2 rounded leading-relaxed">
                      Disponível como tool <span className="text-purple-300">search_knowledge_base</span>(query=&quot;{k.title}&quot;). A IA consulta sob demanda — sem gastar tokens no prompt.
                    </code>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ========= Helpers internos ========= */

function Field({ label, copy, copyLabel, children }: { label: string; copy?: string; copyLabel?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{label}</label>
        {copy !== undefined && <CopyButton text={copy} label={copyLabel} />}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  label, labelColor, color, checked, onChange, hint,
}: {
  label: string; labelColor: string; color: ToggleColor;
  checked: boolean; onChange: (v: boolean) => void; hint: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className={cn("text-[10px] font-black uppercase tracking-widest", labelColor)}>{label}</label>
        <Toggle checked={checked} onCheckedChange={onChange} color={color} size="lg" aria-label={label} />
      </div>
      <p className="text-[9px] text-muted-foreground mt-1 px-1">{hint}</p>
    </div>
  );
}
