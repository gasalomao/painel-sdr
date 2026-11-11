import { describe, it, expect } from "vitest";
import {
  isWithinOperatingHours,
  isSameBrazilDay,
  getBrazilHour,
  generateWarmupMessage,
  evaluateDailyAutoProgress,
} from "../warmup-engine";
import {
  calculateTypingDuration,
  pickFallbackDialogue,
  getRandomReaction,
} from "../warmup-dialogues";
import { STAGE_DEFAULTS, type WarmupConfig } from "../warmup-types";

describe("Warmup Engine - Operating Hours & Brazil Time", () => {
  it("determines whether a time is within operating hours", () => {
    // Cria uma data com hora fixa
    const d10am = new Date("2026-11-09T13:00:00Z"); // 10h em Brasília (UTC-3)
    const brazilHour = getBrazilHour(d10am);
    expect(brazilHour).toBe(10);

    expect(isWithinOperatingHours(8, 20, d10am)).toBe(true);
    expect(isWithinOperatingHours(11, 20, d10am)).toBe(false);
    expect(isWithinOperatingHours(6, 10, d10am)).toBe(false); // 10h não é estritamente < 10
  });

  it("handles wrap-around midnight operating hours", () => {
    const d23pm = new Date("2026-11-09T02:00:00Z"); // 23h em Brasília
    expect(isWithinOperatingHours(22, 4, d23pm)).toBe(true);
  });

  it("identifies same calendar day in Brazil", () => {
    const d1 = "2026-11-09T14:00:00Z";
    const d2 = "2026-11-09T20:00:00Z";
    const d3 = "2026-11-10T04:00:00Z"; // 01:00 do dia 10 em Brasília

    expect(isSameBrazilDay(d1, d2)).toBe(true);
    expect(isSameBrazilDay(d1, d3)).toBe(false);
  });
});

describe("Warmup Dialogues & Human Emulation", () => {
  it("calculates realistic human typing duration based on character length", () => {
    const shortMs = calculateTypingDuration(10, 3, 8);
    expect(shortMs).toBeGreaterThanOrEqual(2000);
    expect(shortMs).toBeLessThanOrEqual(8000);

    const longMs = calculateTypingDuration(200, 3, 8);
    expect(longMs).toBeGreaterThanOrEqual(4000);
    expect(longMs).toBeLessThanOrEqual(8000);
  });

  it("picks valid fallback dialogue scripts", () => {
    const dialogue = pickFallbackDialogue("futebol");
    expect(dialogue).toBeDefined();
    expect(dialogue.turns.length).toBeGreaterThan(0);
    expect(dialogue.turns[0].text).toBeDefined();
    expect(dialogue.turns[0].speaker).toBe("A");
  });

  it("generates random valid reactions", () => {
    const reaction = getRandomReaction();
    expect(typeof reaction).toBe("string");
    expect(reaction.length).toBeGreaterThan(0);
  });

  it("generates fallback message when ai_model is 'fallback'", async () => {
    const res = await generateWarmupMessage({
      theme: "futebol",
      speakerRole: "A",
      history: [],
      aiModel: "fallback",
    });

    expect(res.text).toBeDefined();
    expect(res.text.length).toBeGreaterThan(3);
    expect(res.provider).toBe("native_fallback");
  });
});

describe("Warmup Stage Defaults", () => {
  it("defines progressive stages for chip warming", () => {
    expect(STAGE_DEFAULTS[1].dailyTarget).toBe(10);
    expect(STAGE_DEFAULTS[2].dailyTarget).toBe(25);
    expect(STAGE_DEFAULTS[3].dailyTarget).toBe(50);
    expect(STAGE_DEFAULTS[4].dailyTarget).toBe(70);

    // Intervalos diminuem conforme o chip esquenta
    expect(STAGE_DEFAULTS[1].minInterval).toBeGreaterThan(STAGE_DEFAULTS[4].minInterval);
  });
});

describe("Piloto Automático de Fases (evaluateDailyAutoProgress)", () => {
  const baseConfig: WarmupConfig = {
    client_id: "client-1",
    instance_name: "inst-1",
    enabled: true,
    stage: 1,
    stage_auto_progress: true,
    days_active: 1,
    consecutive_successful_days: 1,
    health_score: 100,
    is_quarantined: false,
    daily_target: 10,
    sent_today: 10,
    received_today: 8,
    error_count_today: 0,
    last_activity_at: "2026-11-09T14:00:00Z",
    min_interval_seconds: 90,
    max_interval_seconds: 300,
    min_typing_seconds: 3,
    max_typing_seconds: 8,
    allowed_start_hour: 8,
    allowed_end_hour: 21,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: true,
    enable_blue_ticks: true,
    enable_reactions: true,
    enable_audio: false,
    enable_vcard: true,
    enable_status_posts: true,
    continuous_warmup: true,
  };

  it("detects same day and does not advance days or stage", () => {
    const res = evaluateDailyAutoProgress(baseConfig, "2026-11-09T20:00:00Z");
    expect(res.isNewDay).toBe(false);
    expect(res.stagePromoted).toBe(false);
    expect(res.newStage).toBe(1);
    expect(res.newDaysActive).toBe(1);
  });

  it("advances days_active when a new calendar day arrives in Brazil", () => {
    const res = evaluateDailyAutoProgress(baseConfig, "2026-11-10T14:00:00Z");
    expect(res.isNewDay).toBe(true);
    expect(res.newDaysActive).toBe(2);
    expect(res.newConsecutiveDays).toBe(2);
    expect(res.stagePromoted).toBe(false);
    expect(res.newStage).toBe(1);
  });

  it("promotes from Stage 1 (Frio) to Stage 2 (Morno) on day 4", () => {
    const cfgDay3: WarmupConfig = {
      ...baseConfig,
      days_active: 3,
      consecutive_successful_days: 3,
    };
    const res = evaluateDailyAutoProgress(cfgDay3, "2026-11-10T14:00:00Z");
    expect(res.isNewDay).toBe(true);
    expect(res.newDaysActive).toBe(4);
    expect(res.stagePromoted).toBe(true);
    expect(res.newStage).toBe(2);
    expect(res.newDailyTarget).toBe(STAGE_DEFAULTS[2].dailyTarget);
  });

  it("promotes from Stage 2 (Morno) to Stage 3 (Quente) on day 8", () => {
    const cfgDay7: WarmupConfig = {
      ...baseConfig,
      stage: 2,
      days_active: 7,
      consecutive_successful_days: 7,
    };
    const res = evaluateDailyAutoProgress(cfgDay7, "2026-11-10T14:00:00Z");
    expect(res.isNewDay).toBe(true);
    expect(res.newDaysActive).toBe(8);
    expect(res.stagePromoted).toBe(true);
    expect(res.newStage).toBe(3);
    expect(res.newDailyTarget).toBe(STAGE_DEFAULTS[3].dailyTarget);
  });

  it("promotes from Stage 3 (Quente) to Stage 4 (Blindado) on day 13", () => {
    const cfgDay12: WarmupConfig = {
      ...baseConfig,
      stage: 3,
      days_active: 12,
      consecutive_successful_days: 12,
    };
    const res = evaluateDailyAutoProgress(cfgDay12, "2026-11-10T14:00:00Z");
    expect(res.isNewDay).toBe(true);
    expect(res.newDaysActive).toBe(13);
    expect(res.stagePromoted).toBe(true);
    expect(res.newStage).toBe(4);
    expect(res.newDailyTarget).toBe(STAGE_DEFAULTS[4].dailyTarget);
  });

  it("does not promote if stage_auto_progress is false", () => {
    const cfgManual: WarmupConfig = {
      ...baseConfig,
      stage: 1,
      stage_auto_progress: false,
      days_active: 5,
    };
    const res = evaluateDailyAutoProgress(cfgManual, "2026-11-10T14:00:00Z");
    expect(res.isNewDay).toBe(true);
    expect(res.stagePromoted).toBe(false);
    expect(res.newStage).toBe(1);
  });

  it("penalizes consecutive days if error occurred today", () => {
    const cfgError: WarmupConfig = {
      ...baseConfig,
      error_count_today: 2,
      consecutive_successful_days: 5,
    };
    const res = evaluateDailyAutoProgress(cfgError, "2026-11-10T14:00:00Z");
    expect(res.newConsecutiveDays).toBe(4);
  });
});

describe("Áudio Real e Comportamentos Avançados de Maturação", () => {
  it("carrega amostra de áudio Opus real com waveform e cabeçalho Ogg", async () => {
    const { getRandomWarmupVoiceBase64 } = await import("../warmup-audio");
    const voiceB64 = getRandomWarmupVoiceBase64();

    expect(typeof voiceB64).toBe("string");
    expect(voiceB64.length).toBeGreaterThan(1000); // Áudio real tem mais de 1KB de dados de onda

    // Ogg Opus em Base64 sempre começa com 'T2dnUw' ("OggS" em ASCII)
    expect(voiceB64.startsWith("T2dnUw")).toBe(true);

    const buffer = Buffer.from(voiceB64, "base64");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("exporta triggerMutualWarmup e enablePairAutopilot para aquecimento mútuo automático", async () => {
    const worker = await import("../warmup-worker");
    expect(typeof worker.triggerMutualWarmup).toBe("function");
    expect(typeof worker.enablePairAutopilot).toBe("function");
  });
});

