"use client";

import { Children, cloneElement, isValidElement, useId, useState, type ReactElement } from "react";
import styles from "../agente.module.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Book, Check, Info, Pencil, Plus, Settings, Trash2, Wrench, X, Image as ImageIcon, Upload, Loader2, Sparkles, Bot, MessageSquare, SlidersHorizontal, CalendarDays, FileText, ChevronDown, ArrowDown, RotateCcw, Globe, Clock, Target, PauseCircle, RefreshCw } from "lucide-react";
import { DEFAULT_SITE_PREVIEW_EVAL_PROMPT, DEFAULT_SITE_PREVIEW_PING_MESSAGE } from "@/lib/sites/agreement-detector-constants";
import { SaveButton } from "../_components/save-button";
import { SectionCard } from "../_components/section-card";
import { EmptyState } from "../_components/empty-state";
import { CopyButton } from "../_components/copy-button";
import { PromptPreview } from "../_components/prompt-preview";
import { Toggle, type ToggleColor } from "../_components/toggle";
import { WebhookGuide } from "../_components/webhook-guide";
import type { PreviewLead, PreviewSample } from "../_components/lead-selector";
import { ModelOptions } from "@/components/ai-module-shared";
import type { GroupableModel } from "@/lib/model-grouping";
import { toast } from "sonner";
import type { SplitIntensity } from "@/lib/agent-format";
import { PROMPT_VARIABLES } from "@/lib/template-vars";

// Rótulos da barra "Intensidade do picote" (1 = picota pouco · 5 = picota muito).
const SPLIT_INTENSITY_LABELS: Record<SplitIntensity, string> = {
  1: "Mínimo",
  2: "Pouco",
  3: "Normal",
  4: "Bastante",
  5: "Máximo",
};

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

// Presets de identidade: um clique preenche Função + Personalidade + Tom.
// Os campos continuam editáveis — o preset é só ponto de partida.
const IDENTITY_PRESETS = [
  {
    id: "sdr",
    label: "SDR de Vendas",
    hint: "Prospecção e agendamento de reuniões",
    funcao: "Você é um pré-vendedor (SDR) que atende clientes no WhatsApp. Seu objetivo é entender a necessidade do cliente, apresentar a solução da empresa e agendar uma reunião ou uma visita.",
    personalidade: "Proativo e simpático. Faz perguntas para entender o cliente antes de oferecer.",
    tom: "Amigável e profissional — informal, mas respeitoso.",
  },
  {
    id: "suporte",
    label: "Atendimento / Suporte",
    hint: "Tira dúvidas sobre produtos e serviços",
    funcao: "Você é um atendente de suporte no WhatsApp. Responde dúvidas sobre produtos, serviços, prazos e políticas da empresa usando a base de conhecimento. Se não souber, coleta as informações e diz que o time vai retornar.",
    personalidade: "Paciente e claro. Explica sem jargão e confirma se a dúvida foi resolvida.",
    tom: "Cordial e objetivo.",
  },
  {
    id: "consultivo",
    label: "Consultivo Especialista",
    hint: "Aconselha como especialista do nicho",
    funcao: "Você é um consultor especialista da área. Faz um diagnóstico da situação do cliente com perguntas inteligentes, recomenda a melhor solução e conduz para o agendamento ou orçamento.",
    personalidade: "Confiante e analítico. Demonstra domínio do assunto sem arrogância.",
    tom: "Profissional e consultivo.",
  },
  {
    id: "formal",
    label: "Formal / Empresarial",
    hint: "Tom sóbrio para marcas sérias",
    funcao: "Você é o assistente de atendimento da empresa no WhatsApp. Presta informações com precisão, registra pedidos e encaminha ao responsável quando necessário.",
    personalidade: "Discreta e eficiente. Sem exageros ou emojis.",
    tom: "Formal e cortês.",
  },
];

type CalendarAutoCaptureCfg = {
  telefone: boolean;
  empresa: boolean;
  necessidade: boolean;
  /** Label customizado pro "necessidade" — adapta o agente ao nicho.
      Ex: "Serviço desejado" pra salão, "Especialidade" pra médico. */
  necessidade_label?: string;
};
type ReminderItem = { offset_minutes: number; message: string };
type KnowledgeDoc = { id: string; title: string; content?: string };

export type InfoTabProps = {
  // Identidade
  nomeAgente: string; setNomeAgente: (v: string) => void;
  funcaoAgente: string; setFuncaoAgente: (v: string) => void;
  personalidadeAgente: string; setPersonalidadeAgente: (v: string) => void;
  tomAgente: string; setTomAgente: (v: string) => void;
  isActiveAgente: boolean; setIsActiveAgente: (v: boolean) => void;
  targetModel: string; setTargetModel: (v: string) => void;
  modelOptions: GroupableModel[];
  isAdmin?: boolean;  // só admin vê/altera modelo de IA (controle de custo)
  defaultAiModel?: string | null;  // modelo padrão da conta definido pelo admin
  appUrl: string; setAppUrl: (v: string) => void;
  vinculoInstance: string; setVinculoInstance: (v: string) => void;
  allInstances: string[];
  savingVinculo: boolean;
  onSaveVinculo: (instanceName: string) => void;
  messageBufferSeconds: number; setMessageBufferSeconds: (n: number) => void;
  humanizeMessages: boolean; setHumanizeMessages: (v: boolean) => void;
  splitIntensity: SplitIntensity; setSplitIntensity: (n: SplitIntensity) => void;
  typingDelayMode: "fixed" | "random"; setTypingDelayMode: (v: "fixed" | "random") => void;
  typingDelaySeconds: number; setTypingDelaySeconds: (n: number) => void;
  typingDelayMinSeconds: number; setTypingDelayMinSeconds: (n: number) => void;
  typingDelayMaxSeconds: number; setTypingDelayMaxSeconds: (n: number) => void;
  customGoalEnabled: boolean; setCustomGoalEnabled: (v: boolean) => void;
  customGoalText: string; setCustomGoalText: (v: string) => void;
  customGoalPauseMode: "timed" | "indefinite"; setCustomGoalPauseMode: (v: "timed" | "indefinite") => void;
  customGoalPauseMinutes: number; setCustomGoalPauseMinutes: (n: number) => void;
  webSearchEnabled: boolean; setWebSearchEnabled: (v: boolean) => void;
  reasoningMode: 0 | 1 | 2 | 3; setReasoningMode: (n: 0 | 1 | 2 | 3) => void;
  leadIntelligenceEnabled: boolean; setLeadIntelligenceEnabled: (v: boolean) => void;
  saveIdentity: (silent?: boolean) => Promise<boolean | void>;
  savingConfig: boolean;
  toggleAgentActive: () => void;

  // Calendar
  calendarEnabled: boolean; setCalendarEnabled: (v: boolean) => void;
  googleJson: string; setGoogleJson: (v: string) => void;
  onTestGoogle: () => void; testingGoogle?: boolean;
  isCalendarConnected?: boolean;
  calendarConnectedEmail?: string | null;
  onDisconnectGoogle?: () => void;
  calendarDefaultDuration: number; setCalendarDefaultDuration: (n: number) => void;
  calendarGenerateMeet: boolean; setCalendarGenerateMeet: (v: boolean) => void;
  calendarSendMeetLink: boolean; setCalendarSendMeetLink: (v: boolean) => void;
  calendarOptionalFields: Record<string, boolean>; setCalendarOptionalFields: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  calendarAutoCapture: CalendarAutoCaptureCfg;
  setCalendarAutoCapture: (fn: (prev: CalendarAutoCaptureCfg) => CalendarAutoCaptureCfg) => void;
  saveCalendarConfig: (silent?: boolean) => Promise<boolean | void>;

  // Scheduler (lembretes automáticos + auto-promote kanban)
  isScheduler: boolean; setIsScheduler: (v: boolean) => void;
  reminders: ReminderItem[];
  setReminders: (fn: (prev: ReminderItem[]) => ReminderItem[]) => void;
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
  autoPromoteDisabled: boolean; setAutoPromoteDisabled: (v: boolean) => void;
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
  savePrompt: (silent?: boolean) => Promise<boolean | void>;
  knowledge: KnowledgeDoc[];

  // Prompt preview
  previewSample: PreviewSample; setPreviewSample: (s: PreviewSample) => void;
  previewOpen: boolean; setPreviewOpen: (v: boolean) => void;
  previewLeads: PreviewLead[]; previewLeadsLoading: boolean;
  loadPreviewLeads: () => void;
  previewSelectedLeadId: number | null;
  applyLeadToSample: (l: PreviewLead) => void;
  previewLeadQuery: string; setPreviewLeadQuery: (v: string) => void;

  // Prévias de Sites IA
  sitePreviewAutoDetect: boolean; setSitePreviewAutoDetect: (v: boolean) => void;
  sitePreviewConfirmBeforeLink: boolean; setSitePreviewConfirmBeforeLink: (v: boolean) => void;
  sitePreviewEvalPrompt: string; setSitePreviewEvalPrompt: (v: string) => void;
  sitePreviewPingMessage: string; setSitePreviewPingMessage: (v: string) => void;
  sitePreviewEvalModel: string; setSitePreviewEvalModel: (v: string) => void;

  // Knowledge base CRUD
  showNovoK: boolean; setShowNovoK: (v: boolean) => void;
  novoKTitle: string; setNovoKTitle: (v: string) => void;
  novoKContent: string; setNovoKContent: (v: string) => void;
  salvarNovoKnowledge: () => void;
  editKId: string | null;
  editKTitle: string; setEditKTitle: (v: string) => void;
  editKContent: string; setEditKContent: (v: string) => void;
  iniciarEdicaoKnowledge: (k: KnowledgeDoc) => void;
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
  } catch (err) {
    toast.error("Erro ao fazer upload da foto: " + (err as Error).message);
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
    <div className="p-4 rounded-xl bg-slate-900/90 border border-blue-500/30 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-blue-400" />
          <h4 className="text-xs font-semibold uppercase tracking-wider text-blue-400">
            Construtor de Produtos e Estoque (Anti-Alucinação)
          </h4>
        </div>
        <Button
          type="button"
          onClick={addProduct}
          variant="outline"
          size="sm"
          className="h-7 text-[10px] font-semibold gap-1 bg-blue-500/10 border-blue-500/30 text-blue-300 hover:bg-blue-500/20"
        >
          <Plus className="w-3 h-3" /> Adicionar Produto
        </Button>
      </div>

      <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
        {products.map((prod, idx) => (
          <div
            key={prod.id}
            className="p-3 bg-black/50 border border-white/10 rounded-xl space-y-3 relative group"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase text-blue-400">
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
                <label className="text-[9px] font-semibold text-muted-foreground uppercase">
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
                <label className="text-[9px] font-semibold text-muted-foreground uppercase">
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
                <label className="text-[9px] font-semibold text-muted-foreground uppercase">
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
                <label className="text-[9px] font-semibold text-muted-foreground uppercase">
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
              <label className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors shrink-0">
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
          className="h-9 px-4 text-xs font-semibold gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl"
        >
          <Sparkles className="w-3.5 h-3.5" /> Inserir Produtos Formatados no Conteúdo
        </Button>
      </div>
    </div>
  );
}

/**
 * Bloco "Opções avançadas" — recolhido por padrão. Esconde configurações
 * técnicas/finas do usuário novo sem removê-las (o estado continua sendo
 * salvo normalmente pelo "Salvar Tudo").
 */
function AdvancedSection({ children, label = "Opções avançadas" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
        className="w-full min-h-12 flex items-center justify-between gap-3 text-left px-4 py-3 hover:bg-white/[0.03] transition-colors cursor-pointer"
      >
        <span className="text-sm font-medium text-foreground flex items-center gap-2">
          <Settings className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" /> {label}
        </span>
        <ChevronDown className={cn("w-4 h-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={contentId} hidden={!open} className="px-4 pb-4 pt-4 space-y-4 border-t border-white/5">{open && children}</div>
    </div>
  );
}

export function InfoTab(p: InfoTabProps) {
  const [uploadingImg, setUploadingImg] = useState(false);
  const { savingConfig } = p;
  // Preset de identidade aplicado por último (só pra destaque visual dos cards)
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const applyIdentityPreset = (preset: (typeof IDENTITY_PRESETS)[number]) => {
    p.setFuncaoAgente(preset.funcao);
    p.setPersonalidadeAgente(preset.personalidade);
    p.setTomAgente(preset.tom);
    setActivePreset(preset.id);
  };

  const saveAll = async () => {
    const ok1 = await p.saveIdentity(true);
    const ok2 = await p.saveCalendarConfig(true);
    const ok3 = await p.savePrompt(true);
    if (ok1 && ok2 && ok3) alert("Tudo salvo com sucesso!");
    else alert("Erro ao salvar — verifique os campos e tente novamente.");
  };

  return (
    <div className={cn(styles.info, "space-y-6")}>
      <aside aria-label="Guia de configuração" className="border-b border-white/10 pb-5 space-y-3">
        <p className="text-sm leading-relaxed text-muted-foreground max-w-prose">
          Comece pela identidade e pelo WhatsApp. Depois, adicione o conhecimento e as instruções. Use a aba <strong className="text-foreground font-medium">Testes</strong> para conferir as respostas.
        </p>
        <nav aria-label="Seções da configuração" className="flex flex-wrap gap-x-4 gap-y-1">
          {[
            ["identidade", "Identidade"], ["whatsapp", "WhatsApp"], ["conversa", "Conversa"],
            ["agenda", "Agenda"], ["conhecimento", "Conhecimento"], ["instrucoes", "Instruções"],
          ].map(([id, label]) => (
            <a key={id} href={`#agente-${id}`} className="inline-flex min-h-10 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary">
              {label}<ArrowDown className="w-3 h-3" aria-hidden="true" />
            </a>
          ))}
        </nav>
      </aside>
      {/* ========= PASSO 1: QUEM É SUA IA ========= */}
      <SectionCard
        id="agente-identidade"
        step={1}
        icon={Bot}
        title="Quem é sua IA?"
        description="Dê um nome e defina a personalidade do seu atendente virtual."
        hint="Comece aqui! Escolha um nome amigável — é assim que a IA vai se apresentar aos seus clientes no WhatsApp."
        accent="primary"
        rightAction={
          <div className="flex items-center gap-3 shrink-0 rounded-lg bg-background px-3 py-2">
            <span className={cn("text-xs font-medium", p.isActiveAgente ? "text-primary" : "text-red-300")}>
              {p.isActiveAgente ? "ATIVO" : "DESLIGADO"}
            </span>
            <Toggle
              checked={p.isActiveAgente}
              onCheckedChange={p.toggleAgentActive}
              color="green"
              size="lg"
              aria-label="Ativar agente"
            />
          </div>
        }
      >

        <div className="space-y-5">
          <Field label="Nome do Agente" copy={p.nomeAgente}>
            <Input value={p.nomeAgente} onChange={(e) => p.setNomeAgente(e.target.value)} placeholder="Ex.: Clara, assistente de atendimento" className="bg-white/5 border-white/10 h-12 rounded-xl text-sm" />
          </Field>

          {/* Presets de identidade — 1 clique preenche Função/Personalidade/Tom */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Comece com um perfil pronto</label>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {IDENTITY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyIdentityPreset(preset)}
                  aria-pressed={activePreset === preset.id}
                  title={preset.hint}
                  className={cn(
                    "text-left rounded-xl border p-3 transition-all cursor-pointer",
                    activePreset === preset.id
                      ? "border-primary/50 bg-primary/10"
                      : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.05]"
                  )}
                >
                  <p className={cn("text-xs font-bold", activePreset === preset.id ? "text-primary" : "text-foreground")}>{preset.label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{preset.hint}</p>
                </button>
              ))}
            </div>
          </div>

          {p.isAdmin ? (
            <div className="space-y-2">
              <label htmlFor="agent-model" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Modelo de IA (Gemini ou OpenRouter)</label>
              <select
                id="agent-model"
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
                <ModelOptions models={p.modelOptions} markNoTools />
              </select>
              <p className="text-[10px] text-muted-foreground mt-1 px-1">
                {p.modelOptions.length > 0
                  ? <>{p.modelOptions.length} modelos disponíveis · só o admin altera. O agente usa ferramentas (agenda, base de conhecimento) — prefira modelos sem o aviso &quot;sem ferramentas&quot;.</>
                  : <>Lista de modelos vazia. Configure a chave do Gemini ou OpenRouter em <a href="/configuracoes" className="text-primary underline decoration-dotted">Configurações</a>.</>}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground px-1">
              Modelo de IA: <span className="font-mono text-foreground/70">{p.targetModel || p.defaultAiModel || "padrão"}</span> · definido pelo admin
            </p>
          )}

          <Field label="Função Principal" copy={p.funcaoAgente}>
            <Textarea value={p.funcaoAgente} onChange={(e) => p.setFuncaoAgente(e.target.value)} className="bg-white/5 border-white/10 h-[100px] resize-none rounded-xl text-sm" />
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Field label="Personalidade" copy={p.personalidadeAgente}>
              <Textarea value={p.personalidadeAgente} onChange={(e) => p.setPersonalidadeAgente(e.target.value)} className="bg-white/5 border-white/10 resize-none h-24 rounded-xl text-sm p-4" />
            </Field>
            <Field label="Tom de Voz" copy={p.tomAgente}>
              <Textarea value={p.tomAgente} onChange={(e) => p.setTomAgente(e.target.value)} className="bg-white/5 border-white/10 resize-none h-24 rounded-xl text-sm p-4" />
            </Field>
          </div>
        </div>
      </SectionCard>

      {/* ========= PASSO 2: CONECTAR NO WHATSAPP ========= */}
      <SectionCard
        id="agente-whatsapp"
        step={2}
        icon={MessageSquare}
        title="Conectar no WhatsApp"
        description="Vincule sua IA a um número de WhatsApp para começar a atender."
        hint="Selecione a instância do WhatsApp que você criou na aba WhatsApp. A IA só funciona depois de conectada aqui."
        accent="blue"
      >

        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="agent-whatsapp" className="text-[11px] font-semibold uppercase tracking-wider text-primary">Instância WhatsApp Vinculada</label>
              {p.savingVinculo ? (
                <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" /> Salvando…
                </span>
              ) : p.vinculoInstance ? (
                <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400 flex items-center gap-1">
                  <Check className="w-2.5 h-2.5" /> Vinculada
                </span>
              ) : null}
            </div>
            <select
              id="agent-whatsapp"
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
              <p className="text-[10px] text-orange-400 mt-1 px-1">
                ⚠ Instância salva (<code>{p.vinculoInstance}</code>) ainda não apareceu na lista — aguarde ou crie em /whatsapp.
              </p>
            )}
            <p className="text-[10px] text-muted-foreground mt-1 px-1">
              Cada agente usa <strong>uma</strong> instância. Trocar aqui transfere o vínculo.
            </p>
          </div>

          <AdvancedSection label="Avançado · URL do app, webhook e Evolution API">
            <Field label="Endereço do App (App URL)" copy={p.appUrl} copyLabel="URL">
              <Input value={p.appUrl} onChange={(e) => p.setAppUrl(e.target.value)} placeholder="https://..." className="bg-white/5 border-white/10 h-10 rounded-xl text-xs" />
            </Field>

            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
              <Info className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
              <p className="text-[10px] text-primary/90 leading-relaxed">
                A <strong>API Key do Gemini</strong> agora é única para todo o sistema. Configure em{" "}
                <a href="/configuracoes" className="underline decoration-dotted font-semibold hover:text-primary">Configurações</a>.
              </p>
            </div>

          {/* Webhook */}
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-[#00ffcc]">Webhook do Agente (cole na Evolution API v2)</label>
              <p className="text-[11px] text-muted-foreground">Endereço que a Evolution API chama para enviar e receber mensagens deste agente.</p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={p.onSyncWebhook}
                className="h-9 px-3 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 text-[10px] font-semibold uppercase tracking-wider"
              >
                Sincronizar Agora
              </Button>
              <CopyButton text={p.webhookUrl} label="Copiar" />
            </div>
            <Input readOnly value={p.webhookUrl} className="bg-black/40 border-white/10 text-xs font-mono h-12 pr-12 w-full" />

            <WebhookGuide webhookUrl={p.webhookUrl} />
          </div>
          </AdvancedSection>
        </div>
      </SectionCard>

      {/* ========= PASSO 3: COMO A IA CONVERSA (avançado) ========= */}
      <SectionCard
        id="agente-conversa"
        step={3}
        icon={SlidersHorizontal}
        title="Como a IA conversa"
        description="Controle o objetivo de parada automática, o estilo e o ritmo das respostas da sua IA."
        accent="cyan"
      >
        {/* ========= OBJETIVO PERSONALIZADO & PAUSA AUTOMÁTICA ========= */}
        <div className="mb-5 overflow-hidden rounded-2xl border border-primary/20 bg-primary/[0.035]">
          <div className="flex flex-col gap-4 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <Target className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold leading-tight text-foreground">
                    Objetivo Personalizado (Pausa Automática)
                  </h4>
                  <span className="inline-flex items-center rounded-full border border-primary/20 bg-background/60 px-2 py-0.5 font-mono text-[10px] text-primary">
                    Micro-IA · 1 token de saída
                  </span>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  Quando o objetivo for alcançado, a IA pausa automaticamente <strong className="text-foreground/80">apenas para aquele contato</strong>.
                </p>
              </div>
            </div>

            <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-background/60 px-3 py-2 sm:w-auto">
              <span className={cn("text-xs font-semibold", p.customGoalEnabled ? "text-primary" : "text-muted-foreground")}>
                {p.customGoalEnabled ? "Ativado" : "Desativado"}
              </span>
              <Toggle
                checked={p.customGoalEnabled}
                onCheckedChange={p.setCustomGoalEnabled}
                color="primary"
                size="lg"
                aria-label="Ativar Objetivo Personalizado"
              />
            </div>
          </div>

          {p.customGoalEnabled && (
            <div className="space-y-5 p-4 sm:p-5">
              {/* Campo de texto livre do objetivo */}
              <div className="space-y-2.5">
                <div>
                  <label htmlFor="custom-goal-text" className="text-sm font-semibold text-foreground">
                    Qual é o objetivo deste agente? (texto livre)
                  </label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Escreva qualquer meta para pausar a IA.
                  </p>
                </div>
                <Textarea
                  id="custom-goal-text"
                  value={p.customGoalText}
                  onChange={(e) => p.setCustomGoalText(e.target.value)}
                  rows={2}
                  placeholder="Ex: marcar uma reunião, enviar a chave PIX, obter o e-mail do cliente, confirmar pedido..."
                  className="resize-y rounded-xl border-primary/25 bg-background/60 text-sm focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                />
                {/* Sugestões rápidas clicáveis (preenchem o texto livre, mas o usuário pode editar como quiser) */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="mr-1 text-[11px] font-medium text-muted-foreground">Exemplos rápidos:</span>
                  {[
                    "Marcar uma reunião ou ligação com o cliente",
                    "Enviar a chave PIX para pagamento",
                    "Obter o e-mail do cliente",
                    "Enviar o link da prévia do site e confirmar recebimento",
                  ].map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => p.setCustomGoalText(sample)}
                      className="rounded-lg border border-white/10 bg-background/50 px-2.5 py-1.5 text-left text-[11px] leading-tight text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>

              {/* Configuração do Tempo de Pausa */}
              <section aria-labelledby="custom-goal-pause-heading" className="space-y-4 border-t border-white/10 pt-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <PauseCircle className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h5 id="custom-goal-pause-heading" className="text-sm font-semibold text-foreground">
                        Comportamento da pausa
                      </h5>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Defina quando a IA volta a atender este contato.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-1 rounded-xl border border-white/10 bg-background/40 p-1 sm:grid-cols-2" role="group" aria-label="Modo de pausa">
                    <button
                      type="button"
                      onClick={() => p.setCustomGoalPauseMode("timed")}
                      aria-pressed={p.customGoalPauseMode === "timed"}
                      className={cn(
                        "min-h-10 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        p.customGoalPauseMode === "timed"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                      )}
                    >
                      Tempo determinado
                    </button>
                    <button
                      type="button"
                      onClick={() => p.setCustomGoalPauseMode("indefinite")}
                      aria-pressed={p.customGoalPauseMode === "indefinite"}
                      className={cn(
                        "min-h-10 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        p.customGoalPauseMode === "indefinite"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                      )}
                    >
                      Tempo indeterminado
                    </button>
                  </div>
                </div>

                {p.customGoalPauseMode === "timed" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor="custom-goal-pause-minutes" className="text-xs font-medium text-foreground/90">
                        Tempo de pausa da IA
                      </label>
                      <span className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                        {p.customGoalPauseMinutes} min
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      <input
                        id="custom-goal-pause-minutes"
                        type="range"
                        min={1}
                        max={240}
                        step={1}
                        value={Math.min(240, p.customGoalPauseMinutes)}
                        onChange={(e) => p.setCustomGoalPauseMinutes(Number(e.target.value))}
                        className="min-w-0 flex-1 cursor-pointer accent-primary"
                        aria-label="Tempo de pausa da IA em minutos"
                      />
                      <NumberInput
                        min={1}
                        max={43200}
                        fallback={30}
                        value={p.customGoalPauseMinutes}
                        onChange={(n) => p.setCustomGoalPauseMinutes(n)}
                        aria-label="Tempo de pausa da IA em minutos"
                        className="h-9 w-24 rounded-lg border-primary/25 bg-background/60 px-2.5 text-center font-mono text-xs text-foreground"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-[11px] font-medium text-muted-foreground">Atalhos:</span>
                      {[15, 30, 60, 120, 360, 1440].map((mins) => (
                        <button
                          key={mins}
                          type="button"
                          onClick={() => p.setCustomGoalPauseMinutes(mins)}
                          className={cn(
                            "rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                            p.customGoalPauseMinutes === mins
                              ? "border-primary/40 bg-primary/15 font-semibold text-primary"
                              : "border-white/10 bg-background/50 text-muted-foreground hover:border-white/20 hover:text-foreground",
                          )}
                        >
                          {mins === 1440 ? "24h (1440m)" : mins === 360 ? "6h (360m)" : `${mins} min`}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-start gap-2 rounded-xl border border-primary/15 bg-primary/[0.04] p-3">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Assim que o objetivo for concluído, a IA fica pausada por <strong className="text-foreground/80">{p.customGoalPauseMinutes} minuto(s)</strong> apenas para aquele contato e volta a atender sozinha quando o tempo acabar. Você também pode reativá-la antes pelo Chat.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-xl border border-primary/15 bg-primary/[0.04] p-3">
                    <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Assim que o objetivo for concluído, a IA fica <strong className="text-foreground/80">pausada por tempo indeterminado</strong> apenas para aquele contato até você ou sua equipe clicar em <strong className="text-foreground/80">Reativar IA</strong> manualmente na conversa do Chat.
                    </p>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        <AdvancedSection label="Abrir ajustes de conversa (buffer, humanizar, raciocínio…)">
        <div className="space-y-3">
          {/* Buffer de mensagens */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-primary">Agrupamento de Mensagens</label>
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
            <p className="text-[10px] text-muted-foreground mt-1 px-1">
              Tempo em segundos que o agente aguarda novas mensagens do mesmo contato antes de responder tudo de uma vez. Use 0 para desativar.
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

          {/* Intensidade do picote — só faz sentido com Humanizar ligado */}
          {p.humanizeMessages && (
            <div className="space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="split-intensity" className="text-[11px] font-semibold uppercase tracking-wider text-[#00ffcc]">
                  Intensidade do picote
                </label>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                  {SPLIT_INTENSITY_LABELS[p.splitIntensity]}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Picotar menos"
                  disabled={p.splitIntensity <= 1}
                  onClick={() => p.setSplitIntensity(Math.max(1, p.splitIntensity - 1) as SplitIntensity)}
                  className="h-8 w-8 shrink-0 rounded-lg border border-white/10 bg-white/5 text-white text-base font-bold hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  −
                </button>
                <input
                  id="split-intensity"
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={p.splitIntensity}
                  onChange={(e) => p.setSplitIntensity(Number(e.target.value) as SplitIntensity)}
                  className="flex-1 accent-emerald-400 cursor-pointer"
                />
                <button
                  type="button"
                  aria-label="Picotar mais"
                  disabled={p.splitIntensity >= 5}
                  onClick={() => p.setSplitIntensity(Math.min(5, p.splitIntensity + 1) as SplitIntensity)}
                  className="h-8 w-8 shrink-0 rounded-lg border border-white/10 bg-white/5 text-white text-base font-bold hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  +
                </button>
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground px-10">
                <span>Menos mensagens</span>
                <span>Mais mensagens</span>
              </div>
              <p className="text-[10px] text-muted-foreground px-1">
                Menos: junta parágrafos e manda blocos maiores. Mais: quebra por linha e por frase, em várias mensagens curtas. O nível Normal é o comportamento de antes.
              </p>
            </div>
          )}

          {/* Simulação de Digitação & Delay Evolution API */}
          <div className="space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-emerald-500/15 text-emerald-400">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-[#00ffcc] block">
                    Delay & Digitando (Evolution API)
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Controla o tempo em que o status &quot;digitando...&quot; aparece no WhatsApp antes do envio.
                  </p>
                </div>
              </div>

              {/* Seletor de Modo: Fixo vs Aleatório */}
              <div className="inline-flex rounded-lg border border-white/10 bg-black/40 p-1 gap-1">
                <button
                  type="button"
                  onClick={() => p.setTypingDelayMode("fixed")}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer",
                    p.typingDelayMode === "fixed"
                      ? "bg-emerald-500 text-black font-semibold shadow-xs"
                      : "text-muted-foreground hover:text-white"
                  )}
                >
                  Fixo
                </button>
                <button
                  type="button"
                  onClick={() => p.setTypingDelayMode("random")}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer",
                    p.typingDelayMode === "random"
                      ? "bg-emerald-500 text-black font-semibold shadow-xs"
                      : "text-muted-foreground hover:text-white"
                  )}
                >
                  Aleatório (Faixa Min–Máx)
                </button>
              </div>
            </div>

            {p.typingDelayMode === "fixed" ? (
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="typing-delay-fixed" className="text-xs text-foreground/90 font-medium">
                    Tempo Fixo de Digitação (Segundos)
                  </label>
                  <span className="text-xs font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                    {p.typingDelaySeconds}s
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    id="typing-delay-fixed"
                    type="range"
                    min={1}
                    max={60}
                    step={1}
                    value={p.typingDelaySeconds}
                    onChange={(e) => p.setTypingDelaySeconds(Number(e.target.value))}
                    className="flex-1 accent-emerald-400 cursor-pointer"
                  />
                  <NumberInput
                    min={1}
                    max={120}
                    fallback={10}
                    value={p.typingDelaySeconds}
                    onChange={(n) => p.setTypingDelaySeconds(n)}
                    className="w-20 bg-white/5 border-emerald-500/30 text-white h-9 rounded-lg text-xs px-2.5 text-center"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground/90 bg-black/20 rounded-md p-2 border border-white/5">
                  ⏱️ O agente simulará digitação por exatamente <strong>{p.typingDelaySeconds} segundos</strong> no WhatsApp antes de disparar cada resposta.
                </p>
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="typing-delay-min" className="text-xs text-foreground/90 font-medium">
                        Tempo Mínimo (segundos)
                      </label>
                      <span className="text-xs font-mono text-emerald-400 font-semibold">{p.typingDelayMinSeconds}s</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        id="typing-delay-min"
                        type="range"
                        min={1}
                        max={Math.min(60, p.typingDelayMaxSeconds)}
                        step={1}
                        value={p.typingDelayMinSeconds}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          p.setTypingDelayMinSeconds(val);
                          if (val > p.typingDelayMaxSeconds) p.setTypingDelayMaxSeconds(val);
                        }}
                        className="flex-1 accent-emerald-400 cursor-pointer"
                      />
                      <NumberInput
                        min={1}
                        max={p.typingDelayMaxSeconds}
                        fallback={5}
                        value={p.typingDelayMinSeconds}
                        onChange={(n) => {
                          p.setTypingDelayMinSeconds(n);
                          if (n > p.typingDelayMaxSeconds) p.setTypingDelayMaxSeconds(n);
                        }}
                        className="w-16 bg-white/5 border-emerald-500/30 text-white h-8 rounded-lg text-xs px-2 text-center"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="typing-delay-max" className="text-xs text-foreground/90 font-medium">
                        Tempo Máximo (segundos)
                      </label>
                      <span className="text-xs font-mono text-emerald-400 font-semibold">{p.typingDelayMaxSeconds}s</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        id="typing-delay-max"
                        type="range"
                        min={p.typingDelayMinSeconds}
                        max={90}
                        step={1}
                        value={p.typingDelayMaxSeconds}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          p.setTypingDelayMaxSeconds(val);
                          if (val < p.typingDelayMinSeconds) p.setTypingDelayMinSeconds(val);
                        }}
                        className="flex-1 accent-emerald-400 cursor-pointer"
                      />
                      <NumberInput
                        min={p.typingDelayMinSeconds}
                        max={120}
                        fallback={25}
                        value={p.typingDelayMaxSeconds}
                        onChange={(n) => {
                          p.setTypingDelayMaxSeconds(n);
                          if (n < p.typingDelayMinSeconds) p.setTypingDelayMinSeconds(n);
                        }}
                        className="w-16 bg-white/5 border-emerald-500/30 text-white h-8 rounded-lg text-xs px-2 text-center"
                      />
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground/90 bg-black/20 rounded-md p-2 border border-white/5">
                  🎲 A cada mensagem, o agente sorteará um tempo aleatório entre <strong>{p.typingDelayMinSeconds}s</strong> e <strong>{p.typingDelayMaxSeconds}s</strong> (ex: {Math.round((p.typingDelayMinSeconds + p.typingDelayMaxSeconds) / 2)}s). Isso humaniza o comportamento no WhatsApp e ajuda a prevenir bloqueios por envios automatizados.
                </p>
              </div>
            )}
          </div>

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
            <label className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">Modo de Raciocínio (custo) — vale para todos os modelos</label>
            <select
              value={p.reasoningMode}
              onChange={(e) => p.setReasoningMode(Number(e.target.value) as 0 | 1 | 2 | 3)}
              className="w-full bg-white/5 border border-amber-400/20 text-white h-12 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
            >
              <option value={0} className="bg-neutral-900 text-white">Econômico — sem raciocínio extra (recomendado p/ SDR)</option>
              <option value={1} className="bg-neutral-900 text-white">Equilibrado — pouco raciocínio (tools/agendamento)</option>
              <option value={2} className="bg-neutral-900 text-white">Intenso — raciocínio total (casos complexos, mais caro)</option>
              <option value={3} className="bg-neutral-900 text-white">Think Máximo — força máxima inteligência + max tokens (mais caro, qualquer modelo)</option>
            </select>
            <p className="text-[11px] text-white/40 leading-relaxed">
              Controla quanto a IA &quot;pensa&quot; antes de responder — <strong>em qualquer modelo</strong> (GPT, Claude, Gemini, DeepSeek). No modo <strong>Econômico</strong> responde direto (gasta menos token, ideal pra SDR). Suba pra <strong>Equilibrado</strong> se usar agendamento/tools, ou <strong>Intenso</strong> em casos complexos. <strong>Think Máximo</strong> força máxima inteligência (boost tokens + temperatura otimizada) em qualquer provedor. Modelos sem suporte ignoram silencioso.
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

          {/* Prévias de Sites IA — Pipeline Autônomo */}
          <div className="pt-3 border-t border-white/5 space-y-4">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-semibold text-white uppercase tracking-wider">Prévias de Sites IA (Pipeline Autônomo)</span>
            </div>

            <ToggleRow
              label="Geração Automática de Prévia ao Detectar Aceite"
              labelColor="text-emerald-400"
              color="emerald"
              checked={p.sitePreviewAutoDetect}
              onChange={p.setSitePreviewAutoDetect}
              hint={<>Quando o cliente concordar em ver a prévia gratuita, uma <strong>IA avaliadora leve</strong> detecta a concordância nas últimas mensagens e aciona o pipeline do OpenCode na VPS automaticamente, sem precisar de clique manual.</>}
            />

            <ToggleRow
              label="Confirmar Disponibilidade Antes do Link (Duplo Vínculo)"
              labelColor="text-blue-400"
              color="blue"
              checked={p.sitePreviewConfirmBeforeLink}
              onChange={p.setSitePreviewConfirmBeforeLink}
              hint={<>Quando ativo, após o deploy do site a IA não manda o link imediatamente: ela primeiro pergunta se o cliente está com o celular na mão para ver. Somente após a confirmação do cliente ela envia o link. Se desativado, envia o link pronto diretamente.</>}
            />

            {p.sitePreviewConfirmBeforeLink && (
              <div className="space-y-1.5 pl-2 border-l-2 border-blue-500/30">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-foreground">
                    Mensagem de Confirmação (Ping de Atenção)
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] text-muted-foreground hover:text-white flex items-center gap-1 px-2"
                    onClick={() => p.setSitePreviewPingMessage(DEFAULT_SITE_PREVIEW_PING_MESSAGE)}
                  >
                    <RotateCcw className="w-3 h-3" /> Restaurar Padrão
                  </Button>
                </div>
                <Textarea
                  value={p.sitePreviewPingMessage}
                  onChange={(e) => p.setSitePreviewPingMessage(e.target.value)}
                  rows={3}
                  placeholder="Mensagem para perguntar se o cliente pode olhar agora..."
                  className="text-xs bg-black/40 border-white/10 resize-y"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use a tag <code className="bg-white/10 px-1 py-0.5 rounded text-primary">{"{{nome_negocio}}"}</code> para inserir o nome da empresa do lead.
                </p>
              </div>
            )}

            {p.sitePreviewAutoDetect && (
              <div className="space-y-1.5 pl-2 border-l-2 border-emerald-500/30">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-foreground">
                      Prompt da IA Avaliadora de Aceite
                    </label>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                      ~50 tokens / avaliação
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] text-muted-foreground hover:text-white flex items-center gap-1 px-2"
                    onClick={() => p.setSitePreviewEvalPrompt(DEFAULT_SITE_PREVIEW_EVAL_PROMPT)}
                  >
                    <RotateCcw className="w-3 h-3" /> Restaurar Padrão
                  </Button>
                </div>
                <Textarea
                  value={p.sitePreviewEvalPrompt}
                  onChange={(e) => p.setSitePreviewEvalPrompt(e.target.value)}
                  rows={5}
                  placeholder="Instruções para o classificador leve de aceite..."
                  className="text-[11px] font-mono bg-black/40 border-white/10 resize-y"
                />
                <p className="text-[11px] text-muted-foreground">
                  A IA avaliadora processa apenas as últimas mensagens trocadas para verificar com precisão cirúrgica se houve concordância formal, sem gastar tokens com a conversa inteira.
                </p>
              </div>
            )}
          </div>
        </div>
        </AdvancedSection>
      </SectionCard>

      {/* ========= PASSO 4: AGENDA E REUNIÕES ========= */}
      <SectionCard
        id="agente-agenda"
        step={4}
        icon={CalendarDays}
        title="Agenda e Reuniões"
        description="Permita que a IA marque atendimentos direto na sua agenda."
        hint="Ative o Google Calendar para a IA poder marcar horários com seus clientes automaticamente."
        accent="blue"
      >

        <div className="flex justify-between items-center bg-black/20 p-4 border border-white/5 rounded-xl">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-xl"><Settings className="w-4 h-4" /></div>
            <div>
              <h4 className="font-semibold text-sm text-white">Google Calendar</h4>
              <p className="text-xs text-muted-foreground mt-0.5">Permite que a IA agende reuniões ativamente.</p>
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
          <div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-4">
            {/* Status da Conexão / Conexão em 1 clique */}
            <div className="rounded-lg border border-white/10 bg-black/30 p-3.5 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-3 h-3 rounded-full shrink-0",
                    p.isCalendarConnected ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-white/20"
                  )} />
                  <div>
                    <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                      {p.isCalendarConnected ? "Conta Google Conectada" : "Conta Google Não Conectada"}
                    </div>
                    <div className="text-[11px] text-white/50">
                      {p.isCalendarConnected && p.calendarConnectedEmail
                        ? `Conectado como ${p.calendarConnectedEmail}`
                        : "Conecte sua conta do Google Agenda para a IA verificar horários livres e agendar reuniões."}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {p.isCalendarConnected ? (
                    <>
                      <button
                        type="button"
                        onClick={p.onTestGoogle}
                        disabled={p.testingGoogle}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 transition-colors flex items-center gap-1.5"
                        title="Reconectar conta do Google"
                      >
                        {p.testingGoogle ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        Reconectar
                      </button>
                      {p.onDisconnectGoogle && (
                        <button
                          type="button"
                          onClick={p.onDisconnectGoogle}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 transition-colors"
                        >
                          Desconectar
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={p.onTestGoogle}
                      disabled={p.testingGoogle}
                      className="text-xs font-semibold px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-colors flex items-center gap-2"
                    >
                      {p.testingGoogle ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarDays className="w-4 h-4" />}
                      Conectar Google Agenda
                    </button>
                  )}
                </div>
              </div>

              {/* Configuração avançada (opcional para quem quiser usar JSON próprio) */}
              <details className="pt-2 border-t border-white/5">
                <summary className="text-[10px] text-white/40 hover:text-white/70 cursor-pointer select-none transition-colors">
                  Configuração avançada (usar credenciais OAuth próprias do Google Cloud)
                </summary>
                <div className="mt-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">OAuth Web Client JSON</label>
                    <CopyButton text={p.googleJson} />
                  </div>
                  <Textarea
                    value={p.googleJson}
                    onChange={(e) => p.setGoogleJson(e.target.value)}
                    placeholder='{"web": {"client_id": "...", "client_secret": "..."}}'
                    className="h-20 bg-black/40 border-white/10 text-xs font-mono text-white/70"
                  />
                  <p className="text-[10px] text-white/40">
                    Opcional: deixe em branco para conectar com 1 clique usando as credenciais centralizadas do sistema.
                  </p>
                </div>
              </details>
            </div>

            {/* Duração padrão */}
            <div className="space-y-2 pt-4 border-t border-white/5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-blue-400">Duração padrão da reunião</label>
              <div className="flex gap-2 items-center">
                <NumberInput
                  min={5}
                  max={480}
                  fallback={30}
                  value={p.calendarDefaultDuration}
                  onChange={(n) => p.setCalendarDefaultDuration(n)}
                  className="bg-black/40 border-white/10 text-sm h-10 w-28 font-mono"
                />
                <span className="text-[10px] text-muted-foreground uppercase font-semibold">minutos por evento</span>
              </div>
              <p className="text-[10px] text-muted-foreground">A IA usa esse valor por padrão. O cliente pode pedir outra duração na conversa.</p>
            </div>

            <AdvancedSection label="Avançado · Google Meet, perguntas e captura automática">
            {/* Gerar Meet */}
            <div className="flex items-center justify-between gap-3 p-2 bg-black/30 rounded-lg border border-white/5">
              <div>
                <p className="text-[11px] font-semibold text-white">Gerar link do Google Meet</p>
                <p className="text-[10px] text-muted-foreground">Cria sala virtual automaticamente em todo evento</p>
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
                  <p className="text-[11px] font-semibold text-white">Enviar o link do Meet ao cliente</p>
                  <p className="text-[10px] text-muted-foreground">Ao agendar, a IA manda o link da reunião direto no WhatsApp do cliente</p>
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
              <label className="text-[11px] font-semibold uppercase tracking-wider text-blue-400">Perguntas diretas ao cliente</label>
              <p className="text-[10px] text-muted-foreground -mt-1">Marque quais informações a IA deve <strong>perguntar diretamente</strong> ao cliente antes de agendar.</p>
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
                        <p className={cn("text-[11px] font-semibold", checked ? "text-blue-200" : "text-white/80")}>{f.label}</p>
                        <p className="text-[10px] text-muted-foreground">{f.hint}</p>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Captura automática */}
              <div className="mt-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Captura automática (sem perguntar)</p>
                {CALENDAR_AUTO_CAPTURE_FIELDS.map((item) => {
                  const on = p.calendarAutoCapture[item.key];
                  // Label dinâmico pro "necessidade" — usa o customizado se existir
                  const displayLabel = item.key === "necessidade" && p.calendarAutoCapture.necessidade_label
                    ? p.calendarAutoCapture.necessidade_label
                    : item.label;
                  return (
                    <div key={item.key} className="flex items-center justify-between gap-3 py-1">
                      <div className="min-w-0">
                        <p className={cn("text-[11px] font-semibold", on ? "text-emerald-200" : "text-muted-foreground")}>{displayLabel}</p>
                        <p className="text-[10px] text-emerald-100/50">{item.desc}</p>
                      </div>
                      <Toggle
                        checked={on}
                        onCheckedChange={(next) => p.setCalendarAutoCapture((prev) => ({ ...prev, [item.key]: next }))}
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
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300/80">Como você chama isso no seu negócio?</p>
                      <p className="text-[10px] text-emerald-100/50 mt-0.5">
                        Esse texto vira o &quot;tipo de serviço&quot; no Google Calendar e no card do /calendario.
                        A IA usa para entender o que perguntar e inferir.
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
                            onClick={() => p.setCalendarAutoCapture((prev) => ({
                              ...prev,
                              necessidade_label: preset.nec_label,
                            }))}
                            className={cn(
                              "text-[10px] font-semibold px-2 py-1 rounded-md border transition",
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
                      onChange={(e) => p.setCalendarAutoCapture((prev) => ({
                        ...prev,
                        necessidade_label: e.target.value,
                      }))}
                      placeholder="Dor / Necessidade (padrão)"
                      className="w-full h-8 px-2 text-xs bg-black/30 border border-white/10 rounded text-emerald-100 placeholder:text-muted-foreground/50 focus:outline-none focus:border-emerald-500/30"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Preview do que vai pro prompt */}
            <div className="space-y-2 pt-4 border-t border-white/5">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-purple-400">Regras auto-injetadas no prompt</label>
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
              <p className="text-[10px] text-muted-foreground italic">Você não precisa escrever isso no prompt — o sistema injeta automaticamente.</p>
            </div>
            </AdvancedSection>

            {/* ========= SCHEDULER: lembretes automáticos + auto-promote kanban ========= */}
            <div className="pt-4 border-t border-white/5 space-y-4">
              <div className="flex justify-between items-center bg-gradient-to-r from-emerald-500/5 to-blue-500/5 p-3 border border-emerald-500/20 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg"><CalendarDays className="w-4 h-4" /></div>
                  <div>
                    <h4 className="font-semibold text-sm text-white">Agente de Agendamento</h4>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Manda lembretes automáticos e move o cliente pro estágio &quot;atendido&quot; depois do horário</p>
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
                <div className="bg-black/30 p-4 rounded-xl border border-emerald-500/10 space-y-4">
                  {/* Lembretes */}
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Lembretes automáticos</label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">A IA manda essas mensagens X minutos antes do agendamento. Use as variáveis abaixo.</p>
                    <div className="space-y-2 mt-2">
                      {p.reminders.map((r, idx) => (
                        <div key={idx} className="bg-black/40 border border-white/5 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <NumberInput
                              min={1}
                              max={43200}
                              fallback={60}
                              value={r.offset_minutes}
                              onChange={(n) => p.setReminders((prev) => prev.map((x, i) => i === idx ? { ...x, offset_minutes: n } : x))}
                              className="bg-black/60 border-white/10 text-xs h-8 w-24 font-mono"
                            />
                            <span className="text-[10px] text-muted-foreground uppercase font-semibold">min antes</span>
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              ({r.offset_minutes >= 1440 ? `${Math.round(r.offset_minutes / 1440)}d` :
                                r.offset_minutes >= 60 ? `${Math.round(r.offset_minutes / 60)}h` : `${r.offset_minutes}min`})
                            </span>
                            <button
                              onClick={() => p.setReminders((prev) => prev.filter((_, i) => i !== idx))}
                              className="text-red-400/70 hover:text-red-400 text-[10px] font-semibold uppercase"
                              title="Remover este lembrete"
                            >Remover</button>
                          </div>
                          <Textarea
                            value={r.message}
                            onChange={(e) => p.setReminders((prev) => prev.map((x, i) => i === idx ? { ...x, message: e.target.value } : x))}
                            className="text-xs bg-black/60 border-white/5 min-h-[60px] resize-none"
                            placeholder="Oi {nome}! Lembrete: amanhã às {hora_agendamento} ..."
                          />
                        </div>
                      ))}
                      <button
                          onClick={() => p.setReminders((prev) => [...prev, { offset_minutes: 30, message: "Oi {nome}! Lembrete do seu agendamento às {hora_agendamento}." }])}
                        className="w-full py-2 rounded-lg border border-dashed border-emerald-500/30 text-[10px] uppercase font-semibold text-emerald-400 hover:bg-emerald-500/5"
                      >
                        + Adicionar lembrete
                      </button>
                    </div>

                    {/* Variáveis disponíveis */}
                    <div className="mt-3">
                      <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-1">Variáveis disponíveis (clique pra copiar)</p>
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

                  <AdvancedSection label="Avançado · Kanban, avisos e resumo pro dono">
                  {/* Auto-promote kanban — De [coluna] → Para [coluna] */}
                  <div className="pt-3 border-t border-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <label className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Auto-mover cliente no kanban</label>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Depois que o agendamento termina, move o cliente de uma coluna pra outra do seu kanban vinculado.</p>
                      </div>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0" title="Desativa totalmente o auto-mover">
                        <input
                          type="checkbox"
                          checked={p.autoPromoteDisabled}
                          onChange={(e) => p.setAutoPromoteDisabled(e.target.checked)}
                          className="accent-emerald-500 h-3.5 w-3.5"
                        />
                        <span className="text-[10px] text-muted-foreground">Desativar</span>
                      </label>
                    </div>
                    <div className="flex gap-2 items-center mt-2" style={{ opacity: p.autoPromoteDisabled ? 0.4 : 1, pointerEvents: p.autoPromoteDisabled ? "none" : "auto" }}>
                      <NumberInput
                        min={0}
                        max={1440}
                        fallback={30}
                        value={p.autoPromoteAfter}
                        onChange={(n) => p.setAutoPromoteAfter(n)}
                        className="bg-black/40 border-white/10 text-sm h-9 w-24 font-mono"
                      />
                      <span className="text-[10px] text-muted-foreground uppercase font-semibold">min após o agendamento</span>
                    </div>

                    {/* Pausa pós-agendamento: silencia a IA pra ESTE contato por
                        X minutos depois de marcar. Evita bombardear o cliente
                        e dá uma janela ao atendente humano. 0 = não pausa. */}
                    <div className="mt-3 p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04]">
                      <label className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Silenciar IA após agendar</label>
                      <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
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
                        <span className="text-[10px] text-muted-foreground uppercase font-semibold">minutos (padrão 120 = 2h)</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-3" style={{ opacity: p.autoPromoteDisabled ? 0.4 : 1, pointerEvents: p.autoPromoteDisabled ? "none" : "auto" }}>
                      <div>
                        <label className="text-[10px] uppercase font-semibold text-muted-foreground">De (coluna de origem)</label>
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
                        <label className="text-[10px] uppercase font-semibold text-muted-foreground">Para (coluna de destino)</label>
                        <select
                          value={p.autoPromoteTo}
                          onChange={(e) => p.setAutoPromoteTo(e.target.value)}
                          className="w-full bg-black/40 border border-white/10 text-white h-9 rounded-lg text-xs px-2 mt-1 focus:outline-none"
                        >
                          <option value="" className="bg-neutral-900">Automático (estágio &quot;atendido/fechado&quot;)</option>
                          {p.kanbanColumns.map((c) => (
                            <option key={c.status_key} value={c.status_key} className="bg-neutral-900">{c.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5">
                      Cada nicho tem colunas próprias (comercial ≠ clínica) — escolha as do seu kanban.
                      {p.kanbanColumns.length === 0 && " ⚠ Nenhuma coluna carregada — configure o kanban primeiro."}
                    </p>
                  </div>

                  {/* Notificar dono */}
                  <div className="pt-3 border-t border-white/5 space-y-2">
                    <div className="flex items-center justify-between gap-3 p-2 bg-black/40 rounded-lg border border-white/5">
                      <div>
                        <p className="text-[11px] font-semibold text-white">Avisar o dono no WhatsApp</p>
                        <p className="text-[10px] text-muted-foreground">Manda mensagem pro seu número quando a IA agendar algo novo</p>
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
                        <p className="text-[11px] font-semibold text-white">Resumo do atendimento por IA pro dono</p>
                        <p className="text-[10px] text-muted-foreground">
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
                      <div className="space-y-2">
                        <p className="text-[10px] text-amber-300/90">
                          ⚠ O resumo é enviado pro número do &quot;Avisar o dono&quot; acima — preencha-o.
                        </p>
                        <div>
                          <label className="text-[10px] uppercase font-semibold text-muted-foreground">
                            Prompt do resumo — descreva o que VOCÊ quer saber
                          </label>
                          <Textarea
                            value={p.ownerSummaryPrompt}
                            onChange={(e) => p.setOwnerSummaryPrompt(e.target.value)}
                            placeholder={"Ex (comercial): Resuma o lead, a dor dele, objeções levantadas, orçamento citado e o que ficou combinado.\nEx (salão): Diga o serviço escolhido, profissional, horário e observações da cliente."}
                            className="text-xs bg-black/60 border-white/5 min-h-[90px] resize-none mt-1"
                          />
                          <p className="text-[10px] text-muted-foreground mt-1">
                            Cada nicho precisa de um resumo diferente — escreva o seu. Em branco = resumo padrão.
                          </p>
                        </div>
                        {p.isAdmin ? (
                          <div>
                            <label className="text-[10px] uppercase font-semibold text-muted-foreground">Modelo de IA do resumo</label>
                            <select
                              value={p.ownerSummaryModel}
                              onChange={(e) => p.setOwnerSummaryModel(e.target.value)}
                              className="w-full bg-black/40 border border-white/10 text-white h-9 rounded-lg text-xs px-2 mt-1 focus:outline-none"
                            >
                              <option value="" className="bg-neutral-900">Padrão da conta</option>
                              {p.ownerSummaryModel && !p.modelOptions.some((m) => m.id === p.ownerSummaryModel) && (
                                <option value={p.ownerSummaryModel} className="bg-neutral-900">{p.ownerSummaryModel} (salvo)</option>
                              )}
                              <ModelOptions models={p.modelOptions} />
                            </select>
                            <p className="text-[10px] text-muted-foreground mt-1">Só o admin escolhe o modelo. Cliente comum usa o padrão da conta.</p>
                          </div>
                        ) : (
                          <p className="text-[10px] text-muted-foreground">Modelo de IA do resumo: padrão da conta (definido pelo admin).</p>
                        )}
                      </div>
                    )}
                  </div>

                  </AdvancedSection>
        </div>
      )}
      </div>
      </div>
      )}
      </SectionCard>

      {/* ========= PASSO 5: BASE DE CONHECIMENTO ========= */}
      <SectionCard
        id="agente-conhecimento"
        step={5}
        icon={Book}
        title="Base de Conhecimento"
        description="Produtos, preços e informações que a IA usa para responder perguntas."
        hint="Adicione aqui catálogos, tabelas de preços ou documentos. A IA só lê quando o cliente pergunta — não inventa resposta."
        accent="purple"
        rightAction={
          <Button onClick={() => p.setShowNovoK(!p.showNovoK)} variant="outline" className="h-11 bg-primary/10 border-primary/20 text-primary hover:bg-primary/20 rounded-xl px-6 font-semibold text-xs uppercase tracking-wider">
            <Plus className="w-4 h-4 mr-2" /> Nova Base
          </Button>
        }
      >

        {p.knowledge.length > 0 && (
          <div className="space-y-3">
            <div className="p-4 rounded-xl bg-purple-500/5 border border-purple-500/15 space-y-2">
              <div className="flex items-center gap-2">
                <Wrench className="w-3.5 h-3.5 text-purple-400" />
                <p className="text-[10px] font-semibold uppercase tracking-wider text-purple-400">Como a IA usa essa base</p>
              </div>
              <p className="text-[11px] text-purple-100/70 leading-relaxed">
                Cada item abaixo vira um <strong>tópico-gatilho</strong>. Quando o cliente perguntar sobre ele, a IA chama
                a tool <code className="text-purple-300 bg-black/30 px-1 rounded">search_knowledge_base</code> com a query
                do tópico — assim ela só lê o conteúdo na hora certa, sem gastar tokens à toa.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 space-y-2.5">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-blue-400" />
                <p className="text-xs font-semibold uppercase tracking-wider text-blue-400">
                  Vinculação de Fotos aos Produtos (Anti-Alucinação — Qualquer Nicho)
                </p>
              </div>
              <p className="text-[11px] text-blue-200/80 leading-relaxed">
                Para cadastrar produtos/itens de qualquer segmento (<strong>Moda, Eletrônicos, Imóveis, Veículos, Cursos, Serviços</strong>) e garantir que a IA envie as fotos reais dos itens com preço correto via WhatsApp, use o Construtor abaixo ou a tag <code className="text-blue-300 bg-black/40 px-1 py-0.5 rounded">[IMAGEM: https://...]</code>.
              </p>
              <div className="bg-black/40 p-3 rounded-xl border border-white/5 space-y-1 font-mono text-[10px] text-blue-200/90">
                <p className="font-semibold text-blue-400">Exemplo genérico para tópico &quot;Catálogo de Produtos&quot;:</p>
                <p>• Produto A (Modelo X) - R$ 199,00 | Estoque: 5 [IMAGEM: https://sua-cdn.com/item1.jpg]</p>
                <p>• Produto B (Modelo Y) - R$ 299,00 | Estoque: 3 [IMAGEM: https://sua-cdn.com/item2.jpg]</p>
              </div>
            </div>
          </div>
        )}

        {p.showNovoK && (
          <div className="p-6 bg-white/5 border border-white/10 rounded-xl space-y-5">
            <div className="space-y-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-primary">Título da Base / Gatilho</label>
              <Input value={p.novoKTitle} onChange={(e) => p.setNovoKTitle(e.target.value)} placeholder="Ex: Catálogo de Produtos, Tabela de Preços, Serviços..." className="bg-black/50 border-white/10" />
              <p className="text-[10px] text-muted-foreground">Use o nome do produto ou palavra-chave. Quando o cliente perguntar disso, a IA lê este documento.</p>
            </div>

            {/* Construtor Estruturado de Catálogo */}
            <ProductCatalogBuilder
              onAppendCatalog={(formattedText) => {
                p.setNovoKContent(p.novoKContent ? `${p.novoKContent}\n\n${formattedText}` : formattedText);
              }}
            />

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-primary">Conteúdo Final do Documento</label>
                <label className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-blue-400 hover:text-blue-300 cursor-pointer bg-blue-500/10 border border-blue-500/20 px-2.5 py-1 rounded-lg transition-colors">
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
                className="h-10 px-5 font-semibold text-xs uppercase tracking-wider gap-2"
              >
                <Plus className="w-4 h-4" /> Criar primeira base
              </Button>
            }
          />
        )}

        <div className="space-y-3">
          {p.knowledge.map((k) => (
            <div key={k.id} className="border border-white/[0.08] bg-card/80 rounded-xl p-4 hover:bg-white/5 transition-colors group">
              {p.editKId === k.id ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-primary">Título</label>
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
                      <label className="text-[11px] font-semibold uppercase tracking-wider text-primary">Conteúdo</label>
                      <label className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-blue-400 hover:text-blue-300 cursor-pointer bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-md transition-colors">
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
                          <h4 className="font-semibold text-sm truncate">{k.title}</h4>
                          {/\[IMAGEM:\s*https?:\/\/[^\s\]]+\]/i.test(k.content || "") && (
                            <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 border border-blue-500/30 px-1.5 py-0.5 text-[9px] font-semibold text-blue-400 shrink-0">
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
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-purple-400 mb-1">Como é usada</p>
                    <code className="block text-[10px] text-purple-200/80 font-mono bg-black/30 p-2 rounded leading-relaxed">
                      Disponível como tool <span className="text-purple-300">search_knowledge_base</span>(query=&quot;{k.title}&quot;). A IA consulta sob demanda — sem gastar tokens no prompt.
                    </code>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ========= PASSO 6: INSTRUÇÕES DA IA ========= */}
      <SectionCard
        id="agente-instrucoes"
        step={6}
        icon={FileText}
        title="Instruções da IA"
        description="Escreva as regras que a IA deve seguir em cada conversa."
        hint="O prompt é o 'manual' da sua IA. Quanto mais claro, melhores as respostas. Use as variáveis abaixo para personalizar."
        accent="primary"
        rightAction={
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground bg-white/5 border border-white/10 rounded-md px-2 py-0.5">
              {p.prompt.length.toLocaleString("pt-BR")} chars
            </span>
            <CopyButton text={p.prompt} label="Copiar" />
          </div>
        }
      >

        <AdvancedSection label="Abrir editor de instruções e prompt">
        <p className="text-[11px] text-muted-foreground -mt-2">
          Clique ou arraste qualquer chip para dentro do editor. As variáveis são substituídas automaticamente na conversa.
        </p>

        {/* Chips: variáveis dinâmicas */}
        <details open className="group rounded-xl bg-cyan-500/5 border border-cyan-500/15 overflow-hidden">
          <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-cyan-500/[0.08] transition list-none">
            <div className="flex items-center gap-2">
              <span className="text-cyan-400 transition-transform group-open:rotate-90 inline-block w-3 text-center">▶</span>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">Variáveis dinâmicas</p>
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
                <span className="text-[11px] font-semibold text-cyan-100">{v.label}</span>
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
                <p className="text-[10px] font-semibold uppercase tracking-wider text-purple-400">Variáveis de conhecimento</p>
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
                    <span className="text-[11px] font-semibold text-purple-100">{k.title}</span>
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
        {/* eslint-disable react-hooks/refs -- falso positivo: a regra envenena todo acesso `p.*` após ler p.promptRef; passar um RefObject pro atributo `ref` é uso legítimo */}
        <div className="rounded-xl bg-[#0a0a0a] border border-white/10 overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-white/5 bg-white/[0.02]">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/60">Editor — prompt cru</p>
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
        {/* eslint-enable react-hooks/refs */}
        </AdvancedSection>

      </SectionCard>

      {/* ===== STICKY SAVE BAR ===== */}
      <div className={styles.saveBar}>
        <p className="hidden sm:block text-xs text-muted-foreground">Ao terminar, salve as configurações deste agente.</p>
        <SaveButton label="Salvar Tudo" onSave={saveAll} disabled={savingConfig} width="auto" className="w-full sm:w-auto normal-case tracking-normal text-sm font-semibold" />
      </div>
    </div>
  );
}

/* ========= Helpers internos ========= */

function Field({ label, copy, copyLabel, children }: { label: string; copy?: string; copyLabel?: string; children: React.ReactNode }) {
  const id = useId();
  const control = Children.only(children);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
        {copy !== undefined && <CopyButton text={copy} label={copyLabel} />}
      </div>
      {isValidElement(control) ? cloneElement(control as ReactElement<{ id?: string }>, { id }) : control}
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
        <label className={cn("text-[11px] font-semibold uppercase tracking-wider", labelColor)}>{label}</label>
        <Toggle checked={checked} onCheckedChange={onChange} color={color} size="lg" aria-label={label} />
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 px-1">{hint}</p>
    </div>
  );
}
