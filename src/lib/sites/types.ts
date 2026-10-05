export type WebsiteFiles = Record<string, string>;
export type ModelMode = "auto" | "quality" | "economy" | "manual";
export type WebsiteClientContext = Partial<Record<"name" | "segment" | "phone" | "whatsapp" | "website" | "city" | "address" | "description" | "services" | "notes", string>>;
export type WebsiteCta = { type: "whatsapp" | "form" | "phone" | "calendar" | "url"; value: string };
export interface WebsiteProject {
  id: string;
  client_id: string;
  name: string;
  slug: string;
  lead_id: number | null;
  client_context: WebsiteClientContext;
  instructions: string;
  model_mode: ModelMode;
  model_id: string | null;
  selected_skill_ids: string[];
  cta: WebsiteCta;
  status: "draft" | "published" | "archived";
  current_revision_id: string | null;
  published_deployment_id: string | null;
  published_url: string | null;
  last_published_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface WebsiteSkill {
  id: string;
  client_id: string | null;
  name: string;
  slug: string;
  description: string;
  instructions: string;
  category: string;
  tags: string[];
  priority: number;
  trigger_mode: "always" | "automatic" | "manual";
  is_enabled: boolean;
  is_builtin: boolean;
  version: number;
  created_at?: string;
  updated_at?: string;
}
export type WebsiteRunStatus = "queued" | "planning" | "editing" | "validating" | "completed" | "failed" | "cancelled";
export interface WebsiteRun {
  id: string;
  client_id: string;
  project_id: string;
  kind?: "agent" | "build";
  status: WebsiteRunStatus;
  prompt: string;
  model_id: string | null;
  base_revision_id: string | null;
  asset_ids: string[];
  error: string | null;
  cancel_requested: boolean;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface WebsiteRevision {
  id: string;
  client_id: string;
  project_id: string;
  parent_id: string | null;
  message: string;
  files: WebsiteFiles;
  hash: string;
  created_at: string;
  actor_id: string;
}
export interface WebsiteAsset {
  id: string;
  client_id: string;
  project_id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  purpose: "content" | "logo" | "reference";
  status?: "pending" | "ready" | "failed" | "deleting";
  url?: string;
  created_at: string;
}
export interface WebsiteMessage {
  id: string;
  project_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}
export interface WebsiteModel {
  id: string;
  name: string;
  supportsTools: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  contextLength?: number;
  pricing?: { prompt?: string; completion?: string };
  provider?: "openrouter" | "gemini" | "gateway" | "nvidia";
  isFree?: boolean;
}
export interface WebsiteQa {
  passed: boolean;
  errors: string[];
  warnings: string[];
  visual_review?: string;
  design_direction?: import("./impeccable").WebsiteDesignDirection;
  impeccable_review?: import("./impeccable").ImpeccableVisualCheck[];
  impeccable_source?: string;
}
export interface WebsiteArtifactFile { content: string; mime: string }
export interface WebsiteBuildResult {
  success: boolean;
  status: "ready" | "failed" | "unconfigured";
  logs: string;
  duration_ms: number;
  artifact: Record<string, WebsiteArtifactFile>;
  errors: string[];
  warnings: string[];
  screenshots: { desktop?: string; mobile?: string };
  qa: WebsiteQa;
}
export interface WebsiteBuild extends WebsiteBuildResult {
  id: string;
  client_id: string;
  project_id: string;
  revision_id: string;
  created_at: string;
}
export interface WebsiteDeployment {
  id: string;
  client_id: string;
  project_id: string;
  build_id: string;
  provider: string;
  status: "deploying" | "published" | "failed";
  provider_id: string | null;
  url: string | null;
  error: string | null;
  created_at: string;
}
export interface WebsiteSettings {
  creative_prompt: string;
  max_sites: number;
  max_runs_per_day: number;
  max_builds_per_day: number;
  max_deploys_per_day: number;
  max_storage_mb: number;
  max_images_per_day: number;
  max_tokens_per_month: number;
  model_allowlist: string[];
  quality_model: string;
  economy_model: string;
  image_model: string;
  image_generation_enabled: boolean;
  base_domain: string;
}
