import React from "react";
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Mock axios para os testes da Evolution API
const axiosMock = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: axiosMock,
}));

// Mock do Supabase
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          single: () => Promise.resolve({ data: null, error: null }),
        }),
        in: () => ({ data: null }),
      }),
    }),
  }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          limit: () => Promise.resolve({ data: [] }),
        }),
      }),
    }),
  },
}));

describe("Teste Completo com Áudio Real (Sara SDR - Prévia de Site)", () => {
  const audioFilePath = "C:/Users/Salomão/.gemini/antigravity/brain/e1801311-c0d1-4cb7-bdce-66b4253eb99a/.user_uploaded/uploaded_media_1793994868370.mp3";
  let audioBuffer: Buffer;
  let audioBase64: string;

  beforeEach(() => {
    expect(fs.existsSync(audioFilePath)).toBe(true);
    audioBuffer = fs.readFileSync(audioFilePath);
    audioBase64 = audioBuffer.toString("base64");

    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { key: { id: "msg-audio-ptt-001" }, ok: true } });
    toastMock.success.mockClear();
    toastMock.error.mockClear();

    vi.stubEnv("EVOLUTION_API_URL", "https://evo.test");
    vi.stubEnv("EVOLUTION_API_KEY", "test-key");
    vi.stubEnv("EVOLUTION_INSTANCE", "inst1");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("1. Valida o arquivo real de áudio MP3 (header ID3, tamanho e conversão Base64)", () => {
    // 364.332 bytes (~355.8 KB)
    expect(audioBuffer.length).toBe(364332);
    // Header ID3 tag (49 44 33 em ASCII: 'ID3')
    expect(audioBuffer[0]).toBe(0x49);
    expect(audioBuffer[1]).toBe(0x44);
    expect(audioBuffer[2]).toBe(0x33);
    // Base64 gerado com fidelidade
    expect(audioBase64.length).toBe(485776);
  });

  it("2. Valida o envio via Evolution V2 (presença 'recording' + encoding: true para PTT nativo)", async () => {
    const { evolution } = await import("@/lib/evolution");

    const res = await evolution.sendMedia(
      "phone:5511991702108",
      "",
      {
        type: "audio",
        base64: audioBase64,
        fileName: "uploaded_media_1793994868370.mp3",
        mimetype: "audio/mpeg",
      },
      "inst1"
    );

    expect(res).toBeDefined();
    expect(axiosMock).toHaveBeenCalledTimes(2);

    // Primeira chamada: Simula gravação ("recording" em vez de "composing")
    const presenceCall = axiosMock.mock.calls[0][0];
    expect(presenceCall.url).toBe("https://evo.test/chat/presence/inst1");
    const presenceBody = typeof presenceCall.data === "string" ? JSON.parse(presenceCall.data) : presenceCall.data;
    expect(presenceBody.number).toBe("5511991702108@s.whatsapp.net");
    expect(presenceBody.presence).toBe("recording");

    // Segunda chamada: sendWhatsAppAudio com encoding: true para transcodificação Opus PTT
    const audioCall = axiosMock.mock.calls[1][0];
    expect(audioCall.url).toBe("https://evo.test/message/sendWhatsAppAudio/inst1");
    const audioBody = typeof audioCall.data === "string" ? JSON.parse(audioCall.data) : audioCall.data;
    expect(audioBody.number).toBe("5511991702108@s.whatsapp.net");
    expect(audioBody.encoding).toBe(true);
    expect(audioBody.delay).toBe(2000);
    expect(audioBody.audio).toBe(audioBase64);
  });

  it("3. Valida o envio via Evolution GO (payload com ptt: true e isPtt: true)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: "go-msg-001" }, status: "sent" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { evolutionGo } = await import("@/lib/providers/evolution-go");

    const res = await evolutionGo.sendMedia(
      "5511991702108@s.whatsapp.net",
      "",
      {
        type: "audio",
        base64: audioBase64,
        fileName: "uploaded_media_1793994868370.mp3",
        mimetype: "audio/mpeg",
      },
      "inst_go_1"
    );

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("go-msg-001");
    expect(fetchMock).toHaveBeenCalled();

    const callArgs = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(callArgs[1].body);
    expect(sentBody.mediatype).toBe("audio");
    expect(sentBody.number).toBe("5511991702108");
    expect(sentBody.ptt).toBe(true);
    expect(sentBody.isPtt).toBe(true);
    expect(sentBody.base64).toBe(audioBase64);
  });

  it("4. Valida a interface do ContactSidebar anexando o áudio real e disparando como PTT", async () => {
    const globalFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/send-message") {
        return new Response(JSON.stringify({ success: true, msgId: "voice-real-001" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, appointments: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", globalFetch);

    const { ContactSidebar } = await import("@/components/inbox/contact-sidebar");

    const contactTest = {
      id: "22222222-2222-4222-8222-222222222222",
      user_id: "tenant-sdr",
      account_id: "tenant-sdr",
      name: "Cliente Lead",
      phone: "5511991702108",
      remote_jid: "5511991702108@s.whatsapp.net",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      tags: [],
    };

    const { container } = render(
      <ContactSidebar contact={contactTest} clientId="tenant-sdr" instanceName="inst-principal" />
    );

    expect(await screen.findByText("Áudio de Voz (Gravado)")).toBeDefined();

    // Cria o objeto File a partir dos bytes reais do arquivo mp3 enviado pelo usuário
    const realAudioFile = new File([audioBuffer], "uploaded_media_1793994868370.mp3", {
      type: "audio/mpeg",
    });

    const fileInput = container.querySelector('input[type="file"][accept*="audio"]') as HTMLInputElement;
    expect(fileInput).toBeDefined();

    fireEvent.change(fileInput, { target: { files: [realAudioFile] } });

    // Confirma que o áudio foi lido e renderizou o card com o nome do arquivo e tamanho
    expect(await screen.findByText("uploaded_media_1793994868370.mp3")).toBeDefined();
    expect(screen.getByText(/355\.8 KB • Pronto para enviar/)).toBeDefined();

    // Clica no botão de envio
    const sendButton = screen.getByRole("button", { name: "Enviar como Áudio Gravado" });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(globalFetch).toHaveBeenCalledWith(
        "/api/send-message",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"type":"audio"'),
        })
      );
    });

    const sentCall = globalFetch.mock.calls.find((c: any[]) => c[0] === "/api/send-message");
    const payload = JSON.parse(sentCall[1].body);
    expect(payload.remoteJid).toBe("5511991702108@s.whatsapp.net");
    expect(payload.instanceName).toBe("inst-principal");
    expect(payload.media.type).toBe("audio");
    expect(payload.media.fileName).toBe("uploaded_media_1793994868370.mp3");
    expect(payload.media.base64).toBe(audioBase64);

    expect(toastMock.success).toHaveBeenCalledWith("Áudio enviado como mensagem de voz gravada!");
  });

  it("5. Valida a interface do MessageComposer com o áudio real", async () => {
    const { MessageComposer } = await import("@/components/inbox/message-composer");
    const mockSendMedia = vi.fn();

    const { container } = render(
      <MessageComposer
        conversationId="5511991702108@s.whatsapp.net"
        onSend={vi.fn()}
        onSendMedia={mockSendMedia}
      />
    );

    const realAudioFile = new File([audioBuffer], "uploaded_media_1793994868370.mp3", {
      type: "audio/mpeg",
    });

    const fileInput = container.querySelector("#composer-picker-audio") as HTMLInputElement;
    expect(fileInput).toBeDefined();

    fireEvent.change(fileInput, { target: { files: [realAudioFile] } });

    // Preview do áudio no compositor
    expect(await screen.findByText("Voz Gravada WhatsApp (PTT)")).toBeDefined();
    expect(screen.getAllByText("uploaded_media_1793994868370.mp3").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Entregue como gravação na hora • Sem etiqueta de encaminhado/)).toBeDefined();

    const sendBtn = screen.getByRole("button", { name: "Enviar como Áudio Gravado" });
    fireEvent.click(sendBtn);

    expect(mockSendMedia).toHaveBeenCalledTimes(1);
    const mediaPayload = mockSendMedia.mock.calls[0][0];
    expect(mediaPayload.kind).toBe("audio");
    expect(mediaPayload.filename).toBe("uploaded_media_1793994868370.mp3");
    expect(mediaPayload.base64).toBe(audioBase64);
  });
});
