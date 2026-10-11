"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toaster, toast as notify } from "sonner";
import { supabase } from "@/lib/supabase";
import { Loader2, Save, RotateCcw, Bot, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useClientSession } from "@/lib/use-session";

interface FollowUpConfig {
  enabled: boolean;
  follow_up_1h_enabled: boolean;
  follow_up_1h_delay_minutes: number;
  follow_up_1h_template: string;
  follow_up_4h_enabled: boolean;
  follow_up_4h_delay_minutes: number;
  follow_up_4h_template: string;
  follow_up_24h_enabled: boolean;
  follow_up_24h_delay_minutes: number;
  follow_up_24h_template: string;
  follow_up_48h_enabled: boolean;
  follow_up_48h_delay_minutes: number;
  follow_up_48h_template: string;
}

interface Agent {
  id: number;
  name: string;
  client_id: string;
}

const DEFAULT_CONFIG: FollowUpConfig = {
  enabled: false,
  follow_up_1h_enabled: true,
  follow_up_1h_delay_minutes: 60,
  follow_up_1h_template: "{{nome}}, sei que a rotina é corrida em {{ramo}}.\n\nA prévia do site tá pronta aqui — é só dar um clique rápido quando tiver um minuto. Quer que eu mande?",
  follow_up_4h_enabled: true,
  follow_up_4h_delay_minutes: 240,
  follow_up_4h_template: "Última chance de ver a prévia hoje.\n\nAmanhã a equipe já vai trabalhar em outro projeto. Libero o link agora?",
  follow_up_24h_enabled: true,
  follow_up_24h_delay_minutes: 1440,
  follow_up_24h_template: "{{nome}}, uma pergunta rápida:\n\nQuantos clientes pesquisam \"{{ramo}} + [cidade]\" no Google por semana e acabam fechando com quem tem site?\n\nNossa estimativa: pelo menos 3-5 oportunidades por semana que vocês perdem.\n\nA prévia que montamos resolve exatamente isso. Quer ver?",
  follow_up_48h_enabled: true,
  follow_up_48h_delay_minutes: 2880,
  follow_up_48h_template: "{{nome}}, entendo se não faz sentido agora.\n\nVou arquivar o projeto da {{nome_empresa}} aqui. Se mudar de ideia, é só chamar. Boa sorte com o negócio! 🚀"
};

export default function FollowUpControlPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [config, setConfig] = useState<FollowUpConfig>(DEFAULT_CONFIG);
  const [stats, setStats] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const configSequence = useRef(0);
  const [loadedAgentId, setLoadedAgentId] = useState<number | null>(null);
  const { clientId } = useClientSession();
  const canSaveConfig = loadedAgentId === selectedAgentId && loadedAgentId !== null;
  function toast(message: { title: string; description?: string; variant?: string }): void {
    if (message.variant === "destructive") notify.error(message.title, { description: message.description });
    else notify.success(message.title, { description: message.description });
  }

  useEffect(() => {
    if (clientId) {
      loadAgents();
    }
  }, [clientId]);

  useEffect(() => {
    if (selectedAgentId) {
      const sequence = ++configSequence.current;
      void loadConfig(selectedAgentId, sequence);
      void loadStats(selectedAgentId);
    }
    return () => { configSequence.current++; };
  }, [selectedAgentId, clientId]);

  async function loadStats(agentId: number) {
    try {
      setLoadingStats(true);
      const response = await fetch(`/api/followup/stats?agent_id=${agentId}`);
      const data = await response.json();

      if (data.success) {
        setStats(data.stats);
      }
    } catch (err: any) {
      console.error("Erro ao carregar estatísticas:", err);
    } finally {
      setLoadingStats(false);
    }
  }

  async function loadAgents() {
    if (!clientId) return;

    try {
      setLoading(true);

      // Busca TODOS os agentes desse cliente
      const { data: agentsList, error: agentsError } = await supabase
        .from("agent_settings")
        .select("id, name, client_id")
        .eq("client_id", clientId)
        .order("name");

      if (agentsError) throw agentsError;

      setAgents(agentsList || []);

      // Seleciona primeiro agente por padrão
      if (agentsList && agentsList.length > 0) {
        setSelectedAgentId(agentsList[0].id);
      }
    } catch (err: any) {
      console.error("Erro ao carregar agentes:", err);
      toast({
        title: "Erro ao carregar agentes",
        description: err.message,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }

  async function loadConfig(agentId: number, sequence: number) {
    if (!clientId) return;
    try {
      const { data: agent, error } = await supabase
        .from("agent_settings")
        .select("options")
        .eq("id", agentId)
        .eq("client_id", clientId)
        .single();

      if (error) throw error;

      if (!agent) throw new Error("Agente não encontrado.");
      if (sequence !== configSequence.current) return;
      const followUpConfig = agent.options?.follow_up || {};

      setConfig({
        enabled: followUpConfig.enabled ?? false,
        follow_up_1h_enabled: followUpConfig.follow_up_1h_enabled ?? true,
        follow_up_1h_delay_minutes: followUpConfig.follow_up_1h_delay_minutes ?? 60,
        follow_up_1h_template: followUpConfig.follow_up_1h_template ?? DEFAULT_CONFIG.follow_up_1h_template,
        follow_up_4h_enabled: followUpConfig.follow_up_4h_enabled ?? true,
        follow_up_4h_delay_minutes: followUpConfig.follow_up_4h_delay_minutes ?? 240,
        follow_up_4h_template: followUpConfig.follow_up_4h_template ?? DEFAULT_CONFIG.follow_up_4h_template,
        follow_up_24h_enabled: followUpConfig.follow_up_24h_enabled ?? true,
        follow_up_24h_delay_minutes: followUpConfig.follow_up_24h_delay_minutes ?? 1440,
        follow_up_24h_template: followUpConfig.follow_up_24h_template ?? DEFAULT_CONFIG.follow_up_24h_template,
        follow_up_48h_enabled: followUpConfig.follow_up_48h_enabled ?? true,
        follow_up_48h_delay_minutes: followUpConfig.follow_up_48h_delay_minutes ?? 2880,
        follow_up_48h_template: followUpConfig.follow_up_48h_template ?? DEFAULT_CONFIG.follow_up_48h_template,
      });
      setLoadedAgentId(agentId);
    } catch (err: any) {
      if (sequence !== configSequence.current) return;
      console.error("Erro ao carregar config:", err);
      toast({
        title: "Erro ao carregar configuração",
        description: err.message,
        variant: "destructive"
      });
    }
  }

  async function saveConfig() {
    if (!selectedAgentId || !clientId || !canSaveConfig) {
      toast({
        title: "Erro",
        description: "Agente ou cliente não selecionado",
        variant: "destructive"
      });
      return;
    }

    try {
      setSaving(true);

      // Busca options atual
      const { data: agent, error: readError } = await supabase
        .from("agent_settings")
        .select("options")
        .eq("id", selectedAgentId)
        .eq("client_id", clientId)
        .single();
      if (readError || !agent) throw new Error("Não foi possível ler as opções atuais. Nada foi salvo.");
      const currentOptions = agent.options || {};

      // Atualiza apenas a seção follow_up
      const { error } = await supabase
        .from("agent_settings")
        .update({
          options: {
            ...currentOptions,
            follow_up: config
          },
          updated_at: new Date().toISOString()
        })
        .eq("id", selectedAgentId)
        .eq("client_id", clientId);

      if (error) throw error;

      toast({
        title: "✅ Configuração salva",
        description: config.enabled
          ? "Follow-ups automáticos estão ATIVOS"
          : "Follow-ups automáticos estão PAUSADOS"
      });
    } catch (err: any) {
      console.error("Erro ao salvar:", err);
      toast({
        title: "Erro ao salvar",
        description: err.message,
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    if (confirm("Tem certeza que deseja restaurar as configurações padrão?")) {
      setConfig(DEFAULT_CONFIG);
      toast({
        title: "Restaurado",
        description: "Configurações padrão restauradas. Clique em Salvar para aplicar."
      });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="container mx-auto h-full overflow-y-auto py-8 px-4 max-w-5xl">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Nenhum agente encontrado para sua conta. Crie um agente primeiro em &quot;Agente IA&quot;.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const selectedAgent = agents.find(a => a.id === selectedAgentId);

  return (
    <div className="container mx-auto h-full overflow-y-auto py-8 px-4 max-w-5xl">
      <Toaster richColors />
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Bot className="h-8 w-8 text-primary" />
          Controle de Follow-ups Automáticos
        </h1>
        <p className="text-muted-foreground mt-2">
          Configure follow-ups automáticos para seus agentes de IA. Quando ativado, o agente enviará mensagens
          de acompanhamento automaticamente para leads que não responderam.
        </p>
      </div>

      {/* Seletor de Agente */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Selecione o Agente</CardTitle>
          <CardDescription>
            Escolha qual agente de IA você deseja configurar os follow-ups
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={selectedAgentId?.toString() || ""}
            onValueChange={(value) => { if (value) { configSequence.current++; setLoadedAgentId(null); setSelectedAgentId(Number(value)); } }}
            disabled={saving}
          >
            <SelectTrigger>
              <SelectValue placeholder="Selecione um agente" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id.toString()}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedAgent && (
            <p className="text-xs text-muted-foreground mt-2">
              Configurando follow-ups para: <span className="font-semibold">{selectedAgent.name}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Estatísticas */}
      {stats && (
        <Card className="mb-6 border-emerald-200 dark:border-emerald-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              📊 Estatísticas de Follow-ups
              {loadingStats && <Loader2 className="h-4 w-4 animate-spin" />}
            </CardTitle>
            <CardDescription>
              Desempenho dos follow-ups automáticos
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.total}</div>
                <div className="text-xs text-muted-foreground">Total</div>
              </div>
              <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg">
                <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats.pending}</div>
                <div className="text-xs text-muted-foreground">Pendentes</div>
              </div>
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/20 rounded-lg">
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats.completed}</div>
                <div className="text-xs text-muted-foreground">Completados</div>
              </div>
              <div className="p-3 bg-purple-50 dark:bg-purple-950/20 rounded-lg">
                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.conversionRate}</div>
                <div className="text-xs text-muted-foreground">Taxa de Resposta</div>
              </div>
            </div>
            <div className="mt-4 text-xs text-muted-foreground">
              <p>• {stats.nextScheduled} follow-up(s) agendado(s) nas próximas 24h</p>
              <p>• {stats.cancelled} lead(s) responderam (follow-ups cancelados)</p>
              {stats.failed > 0 && <p className="text-red-500">• {stats.failed} falha(s) de envio</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Master Switch */}
      <Card className="mb-6 border-2">
        <CardHeader className="bg-muted/50">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Status do Sistema</CardTitle>
              <CardDescription>
                {config.enabled
                  ? "✅ Follow-ups automáticos ATIVOS"
                  : "⏸️ Follow-ups automáticos PAUSADOS"}
              </CardDescription>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => setConfig({ ...config, enabled: checked })}
              className="scale-125"
            />
          </div>
        </CardHeader>
        {!config.enabled && (
          <CardContent className="pt-4">
            <p className="text-sm text-amber-600 dark:text-amber-400">
              ⚠️ Follow-ups estão pausados. Ative o switch acima para começar a enviar mensagens automáticas.
            </p>
          </CardContent>
        )}
      </Card>

      {/* Follow-up 1h */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Follow-up 1: Após 1 hora</CardTitle>
              <CardDescription>
                Primeira tentativa de reengajamento (tom empático)
              </CardDescription>
            </div>
            <Switch
              checked={config.follow_up_1h_enabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, follow_up_1h_enabled: checked })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Delay (minutos)</Label>
            <Input
              type="number"
              min="1"
              max="1440"
              value={config.follow_up_1h_delay_minutes}
              onChange={(e) =>
                setConfig({ ...config, follow_up_1h_delay_minutes: parseInt(e.target.value) || 60 })
              }
              disabled={!config.follow_up_1h_enabled}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Padrão: 60 minutos (1 hora)
            </p>
          </div>
          <div>
            <Label>Mensagem</Label>
            <Textarea
              rows={4}
              value={config.follow_up_1h_template}
              onChange={(e) =>
                setConfig({ ...config, follow_up_1h_template: e.target.value })
              }
              disabled={!config.follow_up_1h_enabled}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Variáveis disponíveis: {"{{nome}}"}, {"{{ramo}}"}, {"{{nome_empresa}}"}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Follow-up 4h */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Follow-up 2: Após 4 horas</CardTitle>
              <CardDescription>
                Urgência leve com escassez (última chance hoje)
              </CardDescription>
            </div>
            <Switch
              checked={config.follow_up_4h_enabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, follow_up_4h_enabled: checked })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Delay (minutos)</Label>
            <Input
              type="number"
              min="1"
              max="1440"
              value={config.follow_up_4h_delay_minutes}
              onChange={(e) =>
                setConfig({ ...config, follow_up_4h_delay_minutes: parseInt(e.target.value) || 240 })
              }
              disabled={!config.follow_up_4h_enabled}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Padrão: 240 minutos (4 horas)
            </p>
          </div>
          <div>
            <Label>Mensagem</Label>
            <Textarea
              rows={4}
              value={config.follow_up_4h_template}
              onChange={(e) =>
                setConfig({ ...config, follow_up_4h_template: e.target.value })
              }
              disabled={!config.follow_up_4h_enabled}
              className="font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Follow-up 24h */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Follow-up 3: Após 24 horas</CardTitle>
              <CardDescription>
                Reengajamento com novo ângulo (dados/estatística)
              </CardDescription>
            </div>
            <Switch
              checked={config.follow_up_24h_enabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, follow_up_24h_enabled: checked })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Delay (minutos)</Label>
            <Input
              type="number"
              min="1"
              max="4320"
              value={config.follow_up_24h_delay_minutes}
              onChange={(e) =>
                setConfig({ ...config, follow_up_24h_delay_minutes: parseInt(e.target.value) || 1440 })
              }
              disabled={!config.follow_up_24h_enabled}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Padrão: 1440 minutos (24 horas)
            </p>
          </div>
          <div>
            <Label>Mensagem</Label>
            <Textarea
              rows={6}
              value={config.follow_up_24h_template}
              onChange={(e) =>
                setConfig({ ...config, follow_up_24h_template: e.target.value })
              }
              disabled={!config.follow_up_24h_enabled}
              className="font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Follow-up 48h */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Follow-up 4: Após 48 horas (Final)</CardTitle>
              <CardDescription>
                Encerramento cordial (deixa porta aberta)
              </CardDescription>
            </div>
            <Switch
              checked={config.follow_up_48h_enabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, follow_up_48h_enabled: checked })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Delay (minutos)</Label>
            <Input
              type="number"
              min="1"
              max="10080"
              value={config.follow_up_48h_delay_minutes}
              onChange={(e) =>
                setConfig({ ...config, follow_up_48h_delay_minutes: parseInt(e.target.value) || 2880 })
              }
              disabled={!config.follow_up_48h_enabled}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Padrão: 2880 minutos (48 horas)
            </p>
          </div>
          <div>
            <Label>Mensagem</Label>
            <Textarea
              rows={4}
              value={config.follow_up_48h_template}
              onChange={(e) =>
                setConfig({ ...config, follow_up_48h_template: e.target.value })
              }
              disabled={!config.follow_up_48h_enabled}
              className="font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Ações */}
      <div className="flex gap-3 justify-end">
        <Button
          variant="outline"
          onClick={resetToDefaults}
          disabled={saving}
        >
          <RotateCcw className="h-4 w-4 mr-2" />
          Restaurar Padrões
        </Button>
        <Button
          onClick={saveConfig}
          disabled={saving || !canSaveConfig}
          size="lg"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Salvando...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Salvar Configuração
            </>
          )}
        </Button>
      </div>

      {/* Info Box */}
      <Card className="mt-6 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
        <CardContent className="pt-6">
          <h3 className="font-semibold mb-2">ℹ️ Como funciona</h3>
          <ul className="text-sm space-y-1 text-muted-foreground">
            <li>• Follow-ups só são enviados se o lead NÃO responder</li>
            <li>• Se o lead responder em qualquer momento, a sequência para</li>
            <li>• Você pode pausar tudo com o switch principal no topo</li>
            <li>• Cada follow-up pode ser ativado/desativado individualmente</li>
            <li>• Os delays são contados a partir da mensagem anterior</li>
            <li>• As configurações são isoladas por agente e por conta</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
