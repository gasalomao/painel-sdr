import { describe, it, expect } from "vitest";
import { safePhotoUrl, getPhotoJid, getPhotoJidAliases } from "../whatsapp-photo-utils";

describe("whatsapp-photo-utils", () => {
  describe("safePhotoUrl", () => {
    it("accepts valid HTTPS URLs from official WhatsApp/Meta hosts", () => {
      const valid = [
        "https://pps.whatsapp.net/v/t61.24694-24/123456_n.jpg?ccb=11-4&oh=abc&oe=xyz",
        "https://mmg.whatsapp.net/v/avatar.jpg",
        "https://media.whatsapp.net/v/profile.png",
        "https://scontent-gru2-1.xx.fbcdn.net/v/t61.24694-24/test.jpg?stp=dst-jpg",
        "https://lookaside.fbsbx.com/v/t61.24694-24/avatar.jpg",
      ];
      for (const url of valid) {
        expect(safePhotoUrl(url)).toBe(url);
      }
    });

    it("rejects non-HTTPS schemes", () => {
      expect(safePhotoUrl("http://pps.whatsapp.net/v/1.jpg")).toBeNull();
      expect(safePhotoUrl("ftp://pps.whatsapp.net/v/1.jpg")).toBeNull();
      expect(safePhotoUrl("javascript:alert(1)")).toBeNull();
    });

    it("rejects base64 and data URLs", () => {
      expect(safePhotoUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).toBeNull();
      expect(safePhotoUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    });

    it("rejects credentials in URL", () => {
      expect(safePhotoUrl("https://user:pass@pps.whatsapp.net/v/1.jpg")).toBeNull();
      expect(safePhotoUrl("https://admin@pps.whatsapp.net/v/1.jpg")).toBeNull();
    });

    it("rejects ports", () => {
      expect(safePhotoUrl("https://pps.whatsapp.net:8080/v/1.jpg")).toBeNull();
      expect(safePhotoUrl("https://pps.whatsapp.net:8443/v/1.jpg")).toBeNull();
      expect(safePhotoUrl("https://pps.whatsapp.net:443/v/1.jpg")).toBeNull();
    });

    it("rejects oversized URLs (> 4096 characters)", () => {
      const longUrl = "https://pps.whatsapp.net/v/" + "a".repeat(4080);
      expect(longUrl.length).toBeGreaterThan(4096);
      expect(safePhotoUrl(longUrl)).toBeNull();
    });

    it("rejects non-Meta hosts and spoofing attempts", () => {
      expect(safePhotoUrl("https://evil.com/fake.jpg")).toBeNull();
      expect(safePhotoUrl("https://evil-whatsapp.com/fake.jpg")).toBeNull();
      expect(safePhotoUrl("https://pps.whatsapp.net.evil.com/fake.jpg")).toBeNull();
      expect(safePhotoUrl("https://whatsapp.net.attacker.org/fake.jpg")).toBeNull();
      expect(safePhotoUrl("https://169.254.169.254/latest/meta-data")).toBeNull();
      expect(safePhotoUrl("https://localhost:3000/avatar.jpg")).toBeNull();
    });

    it("rejects non-string or empty inputs", () => {
      expect(safePhotoUrl(null)).toBeNull();
      expect(safePhotoUrl(undefined)).toBeNull();
      expect(safePhotoUrl("")).toBeNull();
      expect(safePhotoUrl("   ")).toBeNull();
      expect(safePhotoUrl(12345)).toBeNull();
      expect(safePhotoUrl({})).toBeNull();
    });
  });

  it("normaliza prefixos telefônicos e gera aliases móveis BR sem confundir fixos ou estrangeiros", () => {
    expect(getPhotoJid("phone:+55 (11) 99999-9999")).toBe("5511999999999@s.whatsapp.net");
    expect(getPhotoJid("0055 11 99999-9999")).toBe("5511999999999@s.whatsapp.net");
    expect(getPhotoJidAliases("(11) 99999-9999")).toEqual(["5511999999999@s.whatsapp.net", "551199999999@s.whatsapp.net"]);
    expect(getPhotoJidAliases("551199999999@s.whatsapp.net")).toEqual(["551199999999@s.whatsapp.net", "5511999999999@s.whatsapp.net"]);
    expect(getPhotoJidAliases("551132345678@s.whatsapp.net")).toHaveLength(1);
    expect(getPhotoJidAliases("+14155552671")).toHaveLength(1);
    expect(getPhotoJidAliases("1234567890123@lid")).toEqual([]);
  });

  it("rejeita URLs com expiração Meta vencida sem rejeitar parâmetros não temporais", () => {
    expect(safePhotoUrl("https://pps.whatsapp.net/avatar.jpg?oe=5E0BE100")).toBeNull();
    expect(safePhotoUrl("https://pps.whatsapp.net/avatar.jpg?oe=FFFFFFFF")).not.toBeNull();
    expect(safePhotoUrl("https://pps.whatsapp.net/avatar.jpg?oe=xyz")).not.toBeNull();
  });

  describe("getPhotoJid", () => {
    it("normalizes phone numbers to standard @s.whatsapp.net format", () => {
      expect(getPhotoJid("5511999999999")).toBe("5511999999999@s.whatsapp.net");
      expect(getPhotoJid("+55 (11) 99999-9999")).toBe("5511999999999@s.whatsapp.net");
      expect(getPhotoJid("11999999999")).toBe("5511999999999@s.whatsapp.net");
    });

    it("normalizes valid individual WhatsApp JIDs", () => {
      expect(getPhotoJid("5511999999999@s.whatsapp.net")).toBe("5511999999999@s.whatsapp.net");
      expect(getPhotoJid("5511999999999:1@s.whatsapp.net")).toBe("5511999999999@s.whatsapp.net");
      expect(getPhotoJid("5511999999999@c.us")).toBe("5511999999999@s.whatsapp.net");
    });

    it("rejects group JIDs (@g.us)", () => {
      expect(getPhotoJid("1203630248234@g.us")).toBeNull();
      expect(getPhotoJid("551199999-123456@g.us")).toBeNull();
    });

    it("rejects LID JIDs (@lid)", () => {
      expect(getPhotoJid("1234567890123@lid")).toBeNull();
    });

    it("rejects invalid or empty values", () => {
      expect(getPhotoJid(null)).toBeNull();
      expect(getPhotoJid(undefined)).toBeNull();
      expect(getPhotoJid("")).toBeNull();
      expect(getPhotoJid("abc")).toBeNull();
      expect(getPhotoJid(12345)).toBeNull();
    });
  });
});
