/**
 * Testa o cooldown de gateway entre contas (gateway-cooldown.ts).
 *
 * POR QUE EXISTE: quando uma conta conectada (Antigravity, Gemini-cli, Codex…)
 * esgota o uso grátis (429), o sistema tenta automaticamente outra conta. Este
 * módulo decide "pule esta conta por X minutos". Se quebrar, o failover entre
 * contas deixa de funcionar — cliente percebe só como "IA não respondeu".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  markEndpointCooldown,
  markEndpointDead,
  isEndpointUnavailable,
  isEndpointCooling,
  isEndpointDead,
  resetGatewayCooldown,
} from "../gateway-cooldown";

describe("gateway-cooldown", () => {
  beforeEach(() => resetGatewayCooldown());
  afterEach(() => resetGatewayCooldown());

  it("endpoint saudável está disponível", () => {
    expect(isEndpointUnavailable("ep-A")).toBe(false);
    expect(isEndpointCooling("ep-A")).toBe(false);
    expect(isEndpointDead("ep-A")).toBe(false);
  });

  it("markEndpointCooldown marca temporariamente como indisponível", () => {
    markEndpointCooldown("ep-A", 600_000); // 10min — bem acima de qualquer jitter
    expect(isEndpointUnavailable("ep-A")).toBe(true);
    expect(isEndpointCooling("ep-A")).toBe(true);
    expect(isEndpointDead("ep-A")).toBe(false);
  });

  it("markEndpointDead marca como morto PERMANENTEMENTE (até restart)", () => {
    markEndpointDead("ep-A");
    expect(isEndpointDead("ep-A")).toBe(true);
    expect(isEndpointUnavailable("ep-A")).toBe(true);
    expect(isEndpointCooling("ep-A")).toBe(false); // morto não é cooldown
  });

  it("cooldown + morto: morto prevalece (não reseta com cooldown)", () => {
    markEndpointCooldown("ep-A", 600_000);
    markEndpointDead("ep-A");
    expect(isEndpointDead("ep-A")).toBe(true);
    expect(isEndpointUnavailable("ep-A")).toBe(true);
  });

  it("markEndpointCooldown com id vazio é no-op (defensive)", () => {
    markEndpointCooldown("", 600_000);
    expect(isEndpointUnavailable("")).toBe(false);
  });

  it("markEndpointDead com id vazio é no-op", () => {
    markEndpointDead("");
    expect(isEndpointDead("")).toBe(false);
    expect(isEndpointUnavailable("")).toBe(false);
  });

  it("isEndpointCooling distingue cooldown de morto", () => {
    markEndpointCooldown("cooling", 600_000);
    markEndpointDead("dead");
    expect(isEndpointCooling("cooling")).toBe(true);
    expect(isEndpointCooling("dead")).toBe(false);
  });

  it("resetGatewayCooldown limpa todo o estado", () => {
    markEndpointCooldown("ep-A", 600_000);
    markEndpointDead("ep-B");
    resetGatewayCooldown();
    expect(isEndpointUnavailable("ep-A")).toBe(false);
    expect(isEndpointUnavailable("ep-B")).toBe(false);
  });

  it("cooldown expira corretamente quando passa do tempo", () => {
    // Marca por 1ms — praticamente já expira ao rodar a próxima linha
    markEndpointCooldown("ep-A", 1);
    // espera 2ms
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    expect(isEndpointUnavailable("ep-A")).toBe(false);
    expect(isEndpointCooling("ep-A")).toBe(false);
  });
});
