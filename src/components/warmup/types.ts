import type {
  ExternalWarmupMode,
  WarmupConfig,
  WarmupLog,
  WarmupPurpose,
  WarmupStage,
} from "@/lib/warmup/warmup-types";

export interface ChipDeliveryMetrics {
  outbound: number;
  deliveredRate: number;
  readRate: number;
  replyRate: number;
  failed: number;
}

export interface InstanceItem {
  instance_name: string;
  connection_status: string;
  phone_number: string | null;
  orphan?: boolean;
  config: WarmupConfig;
  day0_warnings?: string[];
  day0_status?: "pending" | "warning" | "ok";
  network_warnings?: string[];
  flaps_24h?: number;
  soft_recovery?: boolean;
  metrics?: ChipDeliveryMetrics | null;
  passport?: {
    ban_count?: number;
  } | null;
  proxy: {
    enabled: boolean;
    host: string | null;
    port: string | null;
    protocol: string;
  };
}

export interface ExternalDiagnostic {
  instance_name: string;
  shield_mode: ExternalWarmupMode;
  inbound_today: number;
  inbound_total: number;
  last_received_at: string | null;
  webhook_ok: boolean;
  webhook_url: string | null;
  recent_webhook_upsert_at: string | null;
}

export interface SelfHealingActionRecord {
  id: string;
  instance_name: string;
  issue: string;
  resolution: string;
  status: "fixed" | "needs_attention";
  created_at: string;
}

export interface QuarantineEntry {
  id?: string;
  instance_name: string;
  canonical_sender_phone: string;
  sender_name: string | null;
  message_preview: string | null;
  classification: string;
  seen_count: number;
  last_seen_at: string;
  promoted_to_crm_at: string | null;
}

export interface WarmupStats {
  totalChips: number;
  activeWarmup: number;
  connectedChips?: number;
  orphanChips?: number;
  totalSentToday: number;
  totalReceivedToday: number;
  totalGroups?: number;
  mmzapInboundToday?: number;
}

export type GlobalSettings = {
  ai_model: string;
  ai_theme: string;
  allowed_start_hour: number;
  allowed_end_hour: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  min_typing_seconds: number;
  max_typing_seconds: number;
  enable_typing: boolean;
  enable_blue_ticks: boolean;
  enable_reactions: boolean;
  enable_audio: boolean;
  enable_vcard: boolean;
  enable_status_posts: boolean;
  stage_auto_progress: boolean;
  continuous_warmup: boolean;
  auto_warmup_new_chips: boolean;
  custom_prompt: string;
};

export type {
  ExternalWarmupMode,
  WarmupConfig,
  WarmupLog,
  WarmupPurpose,
  WarmupStage,
};
