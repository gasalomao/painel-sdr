import { describe, it, expect } from "vitest";
import {
  isWithinOperatingHours,
  isSameBrazilDay,
  getBrazilHour,
  generateWarmupMessage,
} from "../warmup-engine";
import {
  calculateTypingDuration,
  pickFallbackDialogue,
  getRandomReaction,
} from "../warmup-dialogues";
import { STAGE_DEFAULTS } from "../warmup-types";

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

