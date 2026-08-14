import { describe, it, expect } from "vitest";
import { isGroupJid } from "@/lib/bot-status";

describe("isGroupJid", () => {
  it("identifica JID de grupo (@g.us)", () => {
    expect(isGroupJid("120363123456789@g.us")).toBe(true);
    expect(isGroupJid("group-name@g.us")).toBe(true);
  });

  it("rejeita JID de chat 1:1 (@s.whatsapp.net)", () => {
    expect(isGroupJid("5511999999999@s.whatsapp.net")).toBe(false);
  });

  it("rejeita JID de broadcast", () => {
    expect(isGroupJid("status@broadcast")).toBe(false);
    expect(isGroupJid("12345@broadcast")).toBe(false);
  });

  it("rejeita null/undefined/vazio", () => {
    expect(isGroupJid(null)).toBe(false);
    expect(isGroupJid(undefined)).toBe(false);
    expect(isGroupJid("")).toBe(false);
  });
});
