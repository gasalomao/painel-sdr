export type WarmupStage = 1 | 2 | 3 | 4;
export type WarmupPurpose = "contingency" | "inbound" | "outbound";
export type WarmupCareerMode = "maturing" | "production_light" | "maintenance" | "rehab";
export type ExternalWarmupMode = "off" | "receive_only" | "hybrid_quarantine";
export type MmzapBrowserStatus =
  | "unpaired"
  | "qr_pending"
  | "needs_extension_setup"
  | "idle"
  | "running"
  | "paused_safety"
  | "error";

export interface MmzapGovernorSettings {
  enabled: boolean;
  max_concurrent_browsers: number;
  shift_duration_minutes: number;
  min_rest_minutes: number;
  max_shifts_stage1: number;
  max_shifts_stage2: number;
  max_shifts_stage3: number;
  max_sends_stage1: number;
  max_sends_stage2: number;
  max_sends_stage3: number;
  max_sends_stage4: number;
  unanswered_brake_threshold: number;
  daily_inbound_target: number;
  auto_disable_stage: 3 | 4;
  day0_cooldown_hours: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
}

export const DEFAULT_MMZAP_GOVERNOR_SETTINGS: MmzapGovernorSettings = {
  enabled: true,
  max_concurrent_browsers: 2,
  shift_duration_minutes: 40,
  min_rest_minutes: 90,
  max_shifts_stage1: 1,
  max_shifts_stage2: 2,
  max_shifts_stage3: 1,
  max_sends_stage1: 4,
  max_sends_stage2: 8,
  max_sends_stage3: 6,
  max_sends_stage4: 0,
  unanswered_brake_threshold: 3,
  daily_inbound_target: 15,
  auto_disable_stage: 4,
  day0_cooldown_hours: 12,
  allowed_start_hour: 8,
  allowed_end_hour: 20,
};

export interface WarmupConfig {
  id?: string;
  client_id: string;
  instance_name: string;
  phone_number?: string | null;
  enabled: boolean;
  stage: WarmupStage; // 1: Frio, 2: Morno, 3: Quente, 4: Blindado
  stage_auto_progress: boolean; // Piloto Automático de subida de fase
  days_active: number;
  consecutive_successful_days: number;
  health_score: number; // 0 a 100%
  is_quarantined: boolean; // Circuit Breaker ativado (quarentena preventiva)
  quarantine_reason?: string | null;
  quarantine_until?: string | null;
  purpose?: WarmupPurpose; // Finalidade: Contingência (7-10d), Inbound (15-21d), Outbound (30-60d)
  profile_hydrated?: boolean; // Se nome, recado e status inicial foram aplicados
  group_auto_join?: boolean; // Se deve entrar automaticamente nos grupos cadastrados
  swarm_active?: boolean; // Se participa da malha aberta com todos os chips da colmeia
  max_groups_per_chip?: number;
  daily_target: number;
  sent_today: number;
  received_today: number;
  error_count_today: number;
  last_activity_at?: string | null;
  last_status_post_at?: string | null;
  vcard_exchanged_peers?: string[]; // Lista de instâncias com as quais já trocou vCard
  min_interval_seconds: number;
  max_interval_seconds: number;
  min_typing_seconds: number;
  max_typing_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  ai_model: string;
  ai_theme: string;
  enable_typing: boolean;
  enable_blue_ticks: boolean;
  enable_reactions: boolean;
  enable_audio: boolean;
  enable_vcard: boolean;
  enable_status_posts: boolean;
  continuous_warmup: boolean; // Continua rodando em segundo plano mesmo durante disparos comerciais
  career_mode?: WarmupCareerMode;
  rehab_until?: string | null;
  cold_outreach_locked_until?: string | null;
  external_warmup_mode?: ExternalWarmupMode;
  external_warmup_inbound_today?: number;
  external_warmup_inbound_total?: number;
  external_warmup_last_at?: string | null;
  external_mmzap_sent_today?: number;
  external_mmzap_sent_total?: number;
  mmzap_browser_enabled?: boolean;
  mmzap_browser_status?: MmzapBrowserStatus;
  mmzap_shift_started_at?: string | null;
  mmzap_last_shift_ended_at?: string | null;
  mmzap_minutes_today?: number;
  mmzap_shifts_today?: number;
  mmzap_max_sends_override?: number | null;
  mmzap_proxy_endpoint?: string | null;
  mmzap_last_error?: string | null;
  internal_groups_enabled?: boolean;
  custom_prompt?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface WarmupGroup {
  id: string;
  client_id: string;
  invite_url: string;
  invite_code: string;
  group_jid?: string | null;
  name?: string | null;
  description?: string | null;
  origin?: "external" | "internal_swarm";
  member_count: number;
  status: "pending" | "active" | "invalid" | "full" | "restricted" | "left";
  last_error?: string | null;
  total_messages_received: number;
  total_reactions_sent: number;
  last_activity_at?: string | null;
  created_at?: string;
  updated_at?: string;
  members?: WarmupGroupMember[];
}

export interface WarmupGroupMember {
  id?: string;
  client_id: string;
  group_id: string;
  instance_name: string;
  status: "pending" | "joining" | "joined" | "left" | "error";
  joined_at?: string | null;
  last_error?: string | null;
  created_at?: string;
}

export const PURPOSE_METADATA: Record<
  WarmupPurpose,
  {
    name: string;
    badge: string;
    recommendedDays: string;
    minDays: number;
    dailyCap: number;
    description: string;
    targetUse: string;
  }
> = {
  contingency: {
    name: "Contingência / Gaveta",
    badge: "🛡️ Contingência",
    recommendedDays: "7 a 10 dias",
    minDays: 7,
    dailyCap: 20,
    description: "Chip reserva para troca rápida caso um número principal caia. Foco em grupos passivos e maturação básica.",
    targetUse: "Ficar pronto como estepe para ativação imediata.",
  },
  inbound: {
    name: "Tráfego Pago / Inbound",
    badge: "🎯 Tráfego & Leads",
    recommendedDays: "15 a 21 dias",
    minDays: 15,
    dailyCap: 40,
    description: "Para receber mensagens de campanhas (Meta Ads, Google). Foco em alta taxa de resposta, áudios e agenda.",
    targetUse: "Receber mensagens de leads desconhecidos sem tomar bloqueio.",
  },
  outbound: {
    name: "Disparo Ativo / Outbound",
    badge: "🚀 Prospecção Ativa",
    recommendedDays: "30 a 60 dias",
    minDays: 30,
    dailyCap: 70,
    description: "O aquecimento mais robusto. Para iniciar conversas frias em massa sem ter o número salvo na agenda do lead.",
    targetUse: "Disparos comerciais, SDR ativo e prospecção em escala.",
  },
};

export interface WarmupLog {
  id?: string;
  client_id: string;
  sender_instance: string;
  receiver_instance: string;
  sender_phone?: string | null;
  receiver_phone?: string | null;
  message_text: string;
  action_type: "text" | "reaction" | "audio" | "sticker" | "image" | "poll" | "presence" | "vcard" | "status" | "circuit_breaker" | "system";
  details?: Record<string, any> | null;
  created_at?: string;
}

export interface WarmupConversationTurn {
  sender: string;
  text: string;
  sent_at: string;
  action_type?: string;
  message_id?: string;
}

export interface WarmupConversation {
  id: string;
  client_id: string;
  instance_a: string;
  instance_b: string;
  topic: string;
  history: WarmupConversationTurn[];
  turn_count: number;
  max_turns: number;
  last_sender?: string | null;
  status: "active" | "finished";
  next_turn_at: string;
  created_at?: string;
  updated_at?: string;
}

export const STAGE_DEFAULTS: Record<
  WarmupStage,
  {
    name: string;
    badge: string;
    description: string;
    recommendedDays: string;
    dailyTarget: number;
    minInterval: number;
    maxInterval: number;
    readiness: "Iniciante" | "Em Aquecimento" | "Quase Pronto" | "Blindado / Pronto para Vendas";
  }
> = {
  1: {
    name: "Fase 1 · Frio",
    badge: "🧊 Frio",
    description: "Chip novo ou recém-ativado (dias 1 a 3). O sistema prioriza receber mensagens mais do que enviar, com intervalos longos e troca de vCards para criar raiz na agenda.",
    recommendedDays: "Dias 1 a 3",
    dailyTarget: 10,
    minInterval: 180,
    maxInterval: 360,
    readiness: "Iniciante",
  },
  2: {
    name: "Fase 2 · Morno",
    badge: "☕ Morno",
    description: "Chip com primeiros dias concluídos com sucesso (dias 4 a 7). Introdução de áudios casuais gravados na hora (PTT Opus), reações com emoji e tiques azuis.",
    recommendedDays: "Dias 4 a 7",
    dailyTarget: 25,
    minInterval: 120,
    maxInterval: 240,
    readiness: "Em Aquecimento",
  },
  3: {
    name: "Fase 3 · Quente",
    badge: "🔥 Quente",
    description: "Volume operacional saudável (dias 8 a 12). Postagem de status (Stories), participação em grupos internos e aceleração controlada do fluxo de mensagens.",
    recommendedDays: "Dias 8 a 12",
    dailyTarget: 50,
    minInterval: 90,
    maxInterval: 180,
    readiness: "Quase Pronto",
  },
  4: {
    name: "Fase 4 · Blindado",
    badge: "🛡️ Blindado",
    description: "Chip maturado e com alta reputação (dia 13+). Liberado com segurança para campanhas de vendas e disparos comerciais, mantendo o aquecimento contínuo em segundo plano.",
    recommendedDays: "Dia 13 em diante",
    dailyTarget: 70,
    minInterval: 60,
    maxInterval: 150,
    readiness: "Blindado / Pronto para Vendas",
  },
};
