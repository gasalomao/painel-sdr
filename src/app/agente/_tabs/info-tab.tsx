"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Book, Check, Info, Pencil, Plus, Save, Settings, Trash2, Wrench, X } from "lucide-react";
import { CopyButton } from "../_components/copy-button";
import { PromptPreview } from "../_components/prompt-preview";
import { Toggle, type ToggleColor } from "../_components/toggle";
import { WebhookGuide } from "../_components/webhook-guide";
import type { PreviewLead, PreviewSample } from "../_components/lead-selector";

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

const CALENDAR_AUTO_CAPTURE_FIELDS = [
  { key: "telefone" as const,    label: "Telefone",          desc: "Número do WhatsApp da conversa vai pra descrição do evento" },
  { key: "empresa" as const,     label: "Empresa",           desc: "IA infere da conversa se for mencionada" },
  { key: "necessidade" as const, label: "Dor / Necessidade", desc: "IA resume o motivo do contato com base no histórico" },
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
  appUrl: string; setAppUrl: (v: string) => void;
  vinculoInstance: string; setVinculoInstance: (v: string) => void;
  allInstances: string[];
  savingVinculo: boolean;
  onSaveVinculo: (instanceName: string) => void;
  messageBufferSeconds: number; setMessageBufferSeconds: (n: number) => void;
  humanizeMessages: boolean; setHumanizeMessages: (v: boolean) => void;
  webSearchEnabled: boolean; setWebSearchEnabled: (v: boolean) => void;
  leadIntelligenceEnabled: boolean; setLeadIntelligenceEnabled: (v: boolean) => void;
  saveIdentity: () => void;
  savingConfig: boolean;
  toggleAgentActive: () => void;

  // Calendar
  calendarEnabled: boolean; setCalendarEnabled: (v: boolean) => void;
  googleJson: string; setGoogleJson: (v: string) => void;
  calendarDefaultDuration: number; setCalendarDefaultDuration: (n: number) => void;
  calendarGenerateMeet: boolean; setCalendarGenerateMeet: (v: boolean) => void;
  calendarOptionalFields: Record<string, boolean>; setCalendarOptionalFields: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  calendarAutoCapture: { telefone: boolean; empresa: boolean; necessidade: boolean };
  setCalendarAutoCapture: (fn: (prev: any) => any) => void;
  saveCalendarConfig: () => void;

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

export function InfoTab(p: InfoTabProps) {
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
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Modelo Gemini (LLM)</label>
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
                {p.modelOptions.map((m) => (
                  <option key={m.id} value={m.id} className="bg-neutral-900">{m.name}</option>
                ))}
              </select>
              <p className="text-[9px] text-muted-foreground mt-1 px-1">
                {p.modelOptions.length > 0
                  ? `${p.modelOptions.length} modelos Gemini disponíveis · chave central configurada.`
                  : <>⚠ Lista de modelos vazia. Configure a chave do Gemini em <a href="/configuracoes" className="text-primary underline decoration-dotted">Configurações</a>.</>}
              </p>
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

            {/* Lead Intelligence — por agente */}
            <ToggleRow
              label="Inteligência de Lead"
              labelColor="text-purple-400"
              color="purple"
              checked={p.leadIntelligenceEnabled}
              onChange={p.setLeadIntelligenceEnabled}
              hint={<>Antes de cada interação, a IA gera um <strong>briefing do lead</strong> (dores, abordagem, decisor, alertas) e usa no contexto. Custa tokens extra — ative só nos agentes que precisam de análise profunda.</>}
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

        <Button onClick={p.saveIdentity} disabled={p.savingConfig} className="w-full h-11 rounded-xl glow-primary font-bold text-xs uppercase tracking-widest mt-4">
          Salvar Identidade
        </Button>

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
                  <CopyButton text={p.googleJson} />
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
                    return (
                      <div key={item.key} className="flex items-center justify-between gap-3 py-1">
                        <div className="min-w-0">
                          <p className={cn("text-[11px] font-bold", on ? "text-emerald-200" : "text-muted-foreground")}>{item.label}</p>
                          <p className="text-[9px] text-emerald-100/50">{item.desc}</p>
                        </div>
                        <Toggle
                          checked={on}
                          onCheckedChange={(next) => p.setCalendarAutoCapture((prev: any) => ({ ...prev, [item.key]: next }))}
                          color="emerald"
                          size="md"
                          aria-label={`Captura automática: ${item.label}`}
                        />
                      </div>
                    );
                  })}
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

              <Button onClick={p.saveCalendarConfig} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs h-10 rounded-lg">
                Salvar Configurações de Agenda
              </Button>
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
            <Button onClick={p.savePrompt} disabled={p.savingConfig} variant="ghost" className="h-9 rounded-xl px-3 text-primary hover:bg-primary/10 font-bold text-xs uppercase tracking-widest gap-2">
              <Save className="w-4 h-4" /> Salvar
            </Button>
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
        )}

        {p.showNovoK && (
          <div className="p-6 bg-white/5 border border-white/10 rounded-2xl space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título (vira o gatilho)</label>
              <Input value={p.novoKTitle} onChange={(e) => p.setNovoKTitle(e.target.value)} placeholder="Ex: Preço, Garantia, Horário de Atendimento..." className="bg-black/50 border-white/10" />
              <p className="text-[9px] text-muted-foreground">Use 1-2 palavras. Quando o cliente mencionar isso, a IA consulta o conteúdo abaixo.</p>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-primary">Conteúdo</label>
              <Textarea value={p.novoKContent} onChange={(e) => p.setNovoKContent(e.target.value)} placeholder="Resposta detalhada que a IA verá quando consultar esse tópico..." className="bg-black/50 border-white/10 h-32 resize-none" />
            </div>
            <Button onClick={p.salvarNovoKnowledge} className="glow-primary w-full">Adicionar ao Conhecimento</Button>
          </div>
        )}

        <div className="space-y-3">
          {p.knowledge.map((k) => (
            <div key={k.id} className="glass-panel border-white/10 rounded-2xl p-4 hover:bg-white/5 transition-colors group bg-white/[0.01]">
              {p.editKId === k.id ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título</label>
                    <Input value={p.editKTitle} onChange={(e) => p.setEditKTitle(e.target.value)} className="bg-black/50 border-white/10" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-primary">Conteúdo</label>
                    <Textarea value={p.editKContent} onChange={(e) => p.setEditKContent(e.target.value)} className="bg-black/50 border-white/10 h-32 resize-none" />
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={p.salvarEdicaoKnowledge} className="flex-1 gap-2"><Save className="w-4 h-4" /> Salvar alterações</Button>
                    <Button onClick={p.cancelarEdicaoKnowledge} variant="outline" className="gap-2"><X className="w-4 h-4" /> Cancelar</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-4 min-w-0">
                      <div className="p-3 bg-blue-500/10 text-blue-400 rounded-xl shrink-0"><Book className="w-5 h-5" /></div>
                      <div className="min-w-0">
                        <h4 className="font-bold text-sm truncate">{k.title}</h4>
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
