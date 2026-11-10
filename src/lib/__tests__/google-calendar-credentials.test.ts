import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolveGoogleCredentials, resolveAppRedirectUri, getOAuthClientForAgentOptions, GoogleCalendarError } from "../google-calendar";

describe("Google Calendar Centralized Credentials & OAuth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolveAppRedirectUri gera o callback padrão baseado na APP_URL", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://painel.meudominio.com";
    const uri = await resolveAppRedirectUri();
    expect(uri).toBe("https://painel.meudominio.com/api/auth/callback/google");
  });

  it("resolveGoogleCredentials prioriza credenciais customizadas se o agente tiver JSON colado", async () => {
    process.env.GOOGLE_CLIENT_ID = "env-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "env-client-secret";

    const customJson = JSON.stringify({
      web: {
        client_id: "custom-client-id",
        client_secret: "custom-client-secret",
        redirect_uris: ["https://meu-custom-site.com/api/auth/callback/google"],
      },
    });

    const res = await resolveGoogleCredentials({ google_credentials: customJson });
    expect(res).not.toBeNull();
    expect(res?.client_id).toBe("custom-client-id");
    expect(res?.client_secret).toBe("custom-client-secret");
    expect(res?.isCustom).toBe(true);
  });

  it("resolveGoogleCredentials usa credenciais centralizadas do servidor (.env) quando o agente não tem JSON (1 clique)", async () => {
    process.env.GOOGLE_CLIENT_ID = "central-platform-id.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "central-platform-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.sdr.com";

    const res = await resolveGoogleCredentials({});
    expect(res).not.toBeNull();
    expect(res?.client_id).toBe("central-platform-id.apps.googleusercontent.com");
    expect(res?.client_secret).toBe("central-platform-secret");
    expect(res?.redirect_uri).toBe("https://app.sdr.com/api/auth/callback/google");
    expect(res?.isCustom).toBe(false);
  });

  it("getOAuthClientForAgentOptions lança erro amigável se o agente ainda não tiver tokens", async () => {
    process.env.GOOGLE_CLIENT_ID = "central-platform-id";
    process.env.GOOGLE_CLIENT_SECRET = "central-platform-secret";

    await expect(
      getOAuthClientForAgentOptions(1, { google_tokens: undefined })
    ).rejects.toThrowError(GoogleCalendarError);
  });
});

