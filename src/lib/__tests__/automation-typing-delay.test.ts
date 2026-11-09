import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateTypingDelayMs,
  calculateTypingDelaySeconds,
  DEFAULT_TYPING_DELAY_CONFIG,
  normalizeTypingDelayConfig,
} from "../agent-delay";

describe("Automação e Prospecção de Sites — Typing Delay (Anti-banimento)", () => {
  it("normaliza typing delay a partir de scrape_filters com snake_case", () => {
    const filters = {
      filterEmpty: true,
      minReviews: 10,
      typing_delay_mode: "fixed",
      typing_delay_seconds: 15,
      typing_delay_min_seconds: 5,
      typing_delay_max_seconds: 30,
    };

    const cfg = normalizeTypingDelayConfig(filters);
    expect(cfg.mode).toBe("fixed");
    expect(cfg.fixedSeconds).toBe(15);
    expect(calculateTypingDelaySeconds(filters)).toBe(15);
    expect(calculateTypingDelayMs(filters)).toBe(15000);
  });

  it("normaliza typing delay com objeto aninhado typing_delay dentro de scrape_filters", () => {
    const filters = {
      _source: "prospeccao-sites",
      typing_delay: {
        mode: "random",
        seconds: 12,
        min_seconds: 7,
        max_seconds: 21,
      },
    };

    const cfg = normalizeTypingDelayConfig(filters);
    expect(cfg.mode).toBe("random");
    expect(cfg.minSeconds).toBe(7);
    expect(cfg.maxSeconds).toBe(21);

    for (let i = 0; i < 50; i++) {
      const sec = calculateTypingDelaySeconds(filters);
      expect(sec).toBeGreaterThanOrEqual(7);
      expect(sec).toBeLessThanOrEqual(21);
    }
  });

  it("garante fallback para DEFAULT_TYPING_DELAY_CONFIG caso scrape_filters não tenha delay configurado", () => {
    const cfg = normalizeTypingDelayConfig({});
    expect(cfg.mode).toBe("random");
    expect(cfg.fixedSeconds).toBe(10);
    expect(cfg.minSeconds).toBe(5);
    expect(cfg.maxSeconds).toBe(25);

    const sec = calculateTypingDelaySeconds({});
    expect(sec).toBeGreaterThanOrEqual(5);
    expect(sec).toBeLessThanOrEqual(25);
  });

  it("corrige limites invertidos (min > max) mantendo segurança operacional", () => {
    const invalid = {
      mode: "random",
      min_seconds: 40,
      max_seconds: 10,
    };

    const cfg = normalizeTypingDelayConfig(invalid);
    expect(cfg.minSeconds).toBe(40);
    expect(cfg.maxSeconds).toBe(40);
    expect(calculateTypingDelaySeconds(invalid)).toBe(40);
  });
});

