/**
 * Testes determinísticos dos helpers de parsing do webhook WhatsApp.
 * São funções PURAS (sem fetch, sem DB, sem rede) — então não precisamos
 * mockar nada. Basta importar e chamar.
 *
 * Cobre os 6 exporters que o webhook usa pra extrair dados da mensagem:
 *   extractText, extractMessageType, extractMimetype,
 *   extractFileName, extractFileSize, extractQuoted
 *
 * IMPORTANTE — formato do argumento:
 *   Os extratores recebem `message` (o nó INTERNO do payload da Evolution),
 *   NÃO o envelope completo. Em produção o webhook faz:
 *     const message = body.data.message || {};
 *     extractText(message);
 *   Então aqui passamos o conteúdo da mensagem direto (sem wrapper `{ message: ... }`).
 *
 * Por que este arquivo existe:
 *   Antes só tínhamos test_webhook_process.test.ts (integration que bate
 *   no Supabase live). Qualquer regressão nos extratores só era descoberta
 *   em produção. Aqui qualquer dev roda `npx vitest run` e valida na hora.
 */
import { describe, it, expect } from "vitest";
import {
  extractText,
  extractMessageType,
  extractMimetype,
  extractFileName,
  extractFileSize,
  extractQuoted,
} from "@/app/api/webhooks/whatsapp/route";

describe("extractText — texto da mensagem", () => {
  it("conversation pura", () => {
    expect(extractText({ conversation: "oi" })).toBe("oi");
  });

  it("extendedTextMessage (resposta citada)", () => {
    const raw = { extendedTextMessage: { text: "resposta" } };
    expect(extractText(raw)).toBe("resposta");
  });

  it("caption de imagem (conta como texto)", () => {
    expect(extractText({ imageMessage: { caption: "legenda", mimetype: "image/jpeg" } })).toBe("legenda");
  });

  it("caption de vídeo", () => {
    expect(extractText({ videoMessage: { caption: "vídeo legenda" } })).toBe("vídeo legenda");
  });

  it("caption de documento", () => {
    expect(extractText({ documentMessage: { caption: "pdf legenda" } })).toBe("pdf legenda");
  });

  it("vazio quando nada bate", () => {
    expect(extractText({ unknownMessage: {} })).toBe("");
  });

  it("protocolMessage → string vazia (controle interno não deve aparecer)", () => {
    expect(extractText({ protocolMessage: { type: 0 } })).toBe("");
  });

  it("locationMessage → descrição amigável", () => {
    const raw = { locationMessage: { name: "Casa", degreesLatitude: 0, degreesLongitude: 0 } };
    expect(extractText(raw)).toBe("📍 Localização: Casa");
  });

  it("contactMessage → nome do contato", () => {
    expect(extractText({ contactMessage: { displayName: "João" } })).toBe("👤 Contato: João");
  });

  it("pollCreationMessage → título", () => {
    expect(extractText({ pollCreationMessage: { name: "Qual horário?" } })).toBe("📊 Enquete: Qual horário?");
  });

  it("reactionMessage → emoji reagido", () => {
    expect(extractText({ reactionMessage: { text: "👍" } })).toBe("↩ Reagiu: 👍");
  });

  it("desempacota wrapper ephemeral/forwarded (unwrapMessage)", () => {
    const raw = {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: { conversation: "msg aninhada" },
          },
        },
      },
    };
    expect(extractText(raw)).toBe("msg aninhada");
  });

  it("templateMessage montável com header + body + botões", () => {
    const raw = {
      templateMessage: {
        hydratedTemplate: {
          hydratedTitleText: "Bem-vindo",
          hydratedContentText: "Escolha uma opção",
          hydratedButtons: [
            { displayText: "Sim", quickReplyButton: { displayText: "Sim" } },
            { displayText: "Não", quickReplyButton: { displayText: "Não" } },
          ],
        },
      },
    };
    const out = extractText(raw);
    expect(out).toContain("*Bem-vindo*");
    expect(out).toContain("Escolha uma opção");
    expect(out).toContain("🔘 Sim");
    expect(out).toContain("🔘 Não");
  });

  it("interactiveMessage com botão de URL renderiza link", () => {
    const raw = {
      interactiveMessage: {
        header: { title: "Confira" },
        body: { text: "Clique abaixo" },
        nativeFlowMessage: {
          buttons: [
            {
              displayText: "Abrir site",
              buttonParamsJson: JSON.stringify({ url: "https://ex.com", display_text: "Abrir site" }),
            },
          ],
        },
      },
    };
    const out = extractText(raw);
    expect(out).toContain("*Confira*");
    expect(out).toContain("Clique abaixo");
    expect(out).toContain("🔗 [Abrir site](https://ex.com)");
  });
});

describe("extractMessageType — categorização", () => {
  it("conversation → text", () => {
    expect(extractMessageType({ conversation: "oi" })).toBe("text");
  });

  it("extendedTextMessage → text", () => {
    expect(extractMessageType({ extendedTextMessage: { text: "x" } })).toBe("text");
  });

  it("imageMessage → image", () => {
    expect(extractMessageType({ imageMessage: { mimetype: "image/jpeg" } })).toBe("image");
  });

  it("videoMessage → video", () => {
    expect(extractMessageType({ videoMessage: {} })).toBe("video");
  });

  it("ptvMessage → video (vídeo redondo)", () => {
    expect(extractMessageType({ ptvMessage: {} })).toBe("video");
  });

  it("audioMessage → audio", () => {
    expect(extractMessageType({ audioMessage: {} })).toBe("audio");
  });

  it("pttMessage → audio (push-to-talk antigo)", () => {
    expect(extractMessageType({ pttMessage: {} })).toBe("audio");
  });

  it("documentMessage → document", () => {
    expect(extractMessageType({ documentMessage: {} })).toBe("document");
  });

  it("stickerMessage → sticker", () => {
    expect(extractMessageType({ stickerMessage: {} })).toBe("sticker");
  });

  it("reactionMessage → reaction", () => {
    expect(extractMessageType({ reactionMessage: { text: "👍" } })).toBe("reaction");
  });

  it("contactMessage → contact", () => {
    expect(extractMessageType({ contactMessage: { displayName: "X" } })).toBe("contact");
  });

  it("locationMessage → location", () => {
    expect(extractMessageType({ locationMessage: {} })).toBe("location");
  });

  it("pollCreationMessageV3 → poll", () => {
    expect(extractMessageType({ pollCreationMessageV3: { name: "x" } })).toBe("poll");
  });

  it("desconhecido → fallback text", () => {
    expect(extractMessageType({ unknownThing: {} })).toBe("text");
  });
});

describe("extractMimetype — mime da mídia", () => {
  it("imageMessage", () => {
    expect(extractMimetype({ imageMessage: { mimetype: "image/jpeg" } })).toBe("image/jpeg");
  });

  it("videoMessage", () => {
    expect(extractMimetype({ videoMessage: { mimetype: "video/mp4" } })).toBe("video/mp4");
  });

  it("ptvMessage herda mime de vídeo", () => {
    expect(extractMimetype({ ptvMessage: { mimetype: "video/mp4" } })).toBe("video/mp4");
  });

  it("audioMessage", () => {
    expect(extractMimetype({ audioMessage: { mimetype: "audio/mp4" } })).toBe("audio/mp4");
  });

  it("pttMessage herda mime de áudio", () => {
    expect(extractMimetype({ pttMessage: { mimetype: "audio/ogg" } })).toBe("audio/ogg");
  });

  it("documentMessage", () => {
    expect(extractMimetype({ documentMessage: { mimetype: "application/pdf" } })).toBe("application/pdf");
  });

  it("stickerMessage", () => {
    expect(extractMimetype({ stickerMessage: { mimetype: "image/webp" } })).toBe("image/webp");
  });

  it("texto puro → null", () => {
    expect(extractMimetype({ conversation: "oi" })).toBeNull();
  });
});

describe("extractFileName / extractFileSize", () => {
  it("fileName documento", () => {
    expect(extractFileName({ documentMessage: { fileName: "boleto.pdf" } })).toBe("boleto.pdf");
  });

  it("fileName imagem (se Evolution enviar)", () => {
    expect(extractFileName({ imageMessage: { fileName: "foto.jpg" } })).toBe("foto.jpg");
  });

  it("sem mídia → null", () => {
    expect(extractFileName({ conversation: "oi" })).toBeNull();
  });

  it("fileLength de imagem como número", () => {
    expect(extractFileSize({ imageMessage: { fileLength: "12345" } })).toBe(12345);
  });

  it("fileLength ausente → null", () => {
    expect(extractFileSize({ conversation: "oi" })).toBeNull();
  });
});

describe("extractQuoted — resposta citada", () => {
  it("extendedTextMessage com quoted de texto", () => {
    const raw = {
      extendedTextMessage: {
        text: " Concordo",
        contextInfo: {
          stanzaId: "msg-origem-123",
          quotedMessage: { conversation: "Original" },
        },
      },
    };
    const r = extractQuoted(raw);
    expect(r.quotedId).toBe("msg-origem-123");
    expect(r.quotedText).toBe("Original");
  });

  it("quoted imagem sem caption → fallback '📷 Imagem'", () => {
    const raw = {
      extendedTextMessage: {
        text: "link",
        contextInfo: {
          stanzaId: "m1",
          quotedMessage: { imageMessage: { mimetype: "image/jpeg" } },
        },
      },
    };
    const r = extractQuoted(raw);
    expect(r.quotedText).toBe("📷 Imagem");
  });

  it("quoted vídeo → '🎥 Vídeo'", () => {
    const raw = {
      imageMessage: {
        caption: "x",
        contextInfo: {
          stanzaId: "m2",
          quotedMessage: { videoMessage: { mimetype: "video/mp4" } },
        },
      },
    };
    const r = extractQuoted(raw);
    expect(r.quotedText).toBe("🎥 Vídeo");
  });

  it("sem contextInfo → quotedId/quotedText null", () => {
    expect(extractQuoted({ conversation: "oi" })).toEqual({
      quotedId: null,
      quotedText: null,
    });
  });
});
