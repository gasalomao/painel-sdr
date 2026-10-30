import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import {
  isGooglePlacePhotoUrl,
  toHighResGooglePhotoUrls,
  mergeMapsKitData,
  formatLeadKitTxt,
  buildLeadMapsKitArchive,
} from "../lead-maps-kit";

describe("lead-maps-kit", () => {
  it("filtra apenas fotos reais do estabelecimento no Google Maps e ignora avatares de usuários", () => {
    expect(
      isGooglePlacePhotoUrl(
        "https://lh3.googleusercontent.com/p/AF1QipN1234567890=w408-h306-k-no"
      )
    ).toBe(true);
    expect(
      isGooglePlacePhotoUrl(
        "https://lh3.googleusercontent.com/gps-cs-s/AC9h4n123456=w203-h152-k-no"
      )
    ).toBe(true);
    expect(
      isGooglePlacePhotoUrl(
        "https://lh3.googleusercontent.com/a-/ALV-UjReviewerAvatar=s40-c"
      )
    ).toBe(false);
    expect(
      isGooglePlacePhotoUrl(
        "https://lh3.googleusercontent.com/a/ACg8ocReviewerAvatar=s64-c"
      )
    ).toBe(false);
    expect(isGooglePlacePhotoUrl("https://maps.gstatic.com/mapfiles/icon.png")).toBe(false);
  });

  it("converte URLs de fotos do Google Maps para alta resolução", () => {
    const candidates = toHighResGooglePhotoUrls(
      "https://lh3.googleusercontent.com/p/AF1QipN1234567890=w203-h152-k-no"
    );
    expect(candidates[0]).toBe(
      "https://lh3.googleusercontent.com/p/AF1QipN1234567890=w1600-h1200-k-no"
    );
    expect(candidates).toContain(
      "https://lh3.googleusercontent.com/p/AF1QipN1234567890=s1600-k-no"
    );
  });

  it("mescla dados do banco com dados extraídos do Google Maps e gera TXT rico para criação de sites", () => {
    const dbLead = {
      id: 42,
      nome_negocio: "Curso de Bronzeamento São Paulo",
      ramo_negocio: "Salão de Beleza",
      telefone: "+55 (11) 98912-3420",
      remoteJid: "5511989123420@s.whatsapp.net",
      endereco: "Av. Brigadeiro Faria Lima, 1500 - Pinheiros, São Paulo - SP, 01451-001",
      avaliacao: 5,
      reviews: 60,
      maps_url: "https://www.google.com/maps/place/Curso+de+Bronzeamento",
      instagram: "https://instagram.com/cursobronze",
      resumo_ia: "Clientes elogiam o atendimento impecável e o resultado natural do bronzeamento.",
    };

    const scraped = {
      openingHours: {
        "segunda-feira": "08:00–19:00",
        "terça-feira": "08:00–19:00",
        "quarta-feira": "08:00–19:00",
        "quinta-feira": "08:00–19:00",
        "sexta-feira": "08:00–20:00",
        sábado: "09:00–18:00",
        domingo: "Fechado",
      },
      about: "Especialistas em bronzeamento natural e cursos profissionalizantes em São Paulo.",
      services: ["Bronzeamento a jato", "Bronzeamento na fita", "Curso profissionalizante"],
      attributeSections: {
        Comodidades: ["Wi-Fi gratuito", "Ambiente climatizado"],
        Pagamentos: ["Pix", "Cartão de crédito", "Cartão de débito"],
      },
      photos: [
        "https://lh3.googleusercontent.com/p/AF1QipFoto1=w408-h306-k-no",
        "https://lh3.googleusercontent.com/p/AF1QipFoto2=w408-h306-k-no",
      ],
      reviews: [
        {
          autor: "Maria Fernanda",
          nota: "5",
          data: "há 2 semanas",
          texto: "Melhor curso e atendimento maravilhoso!",
          respostaDono: "Muito obrigada pelo carinho, Maria!",
        },
      ],
    };

    const merged = mergeMapsKitData(dbLead, scraped);
    expect(merged.nomeNegocio).toBe("Curso de Bronzeamento São Paulo");
    expect(merged.horariosFuncionamento["segunda-feira"]).toBe("08:00–19:00");
    expect(merged.fotosUrls).toHaveLength(2);

    const txt = formatLeadKitTxt(merged, [
      {
        fileName: "foto-01.jpg",
        originalUrl: merged.fotosUrls[0],
        sizeBytes: 120000,
      },
      {
        fileName: "foto-02.jpg",
        originalUrl: merged.fotosUrls[1],
        sizeBytes: 98000,
      },
    ]);

    expect(txt).toContain("Curso de Bronzeamento São Paulo");
    expect(txt).toContain("https://www.google.com/maps/place/Curso+de+Bronzeamento");
    expect(txt).toContain("Segunda-feira: 08:00–19:00");
    expect(txt).toContain("https://wa.me/5511989123420");
    expect(txt).toContain("Bronzeamento a jato");
    expect(txt).toContain("Maria Fernanda");
    expect(txt).toContain("fotos/foto-01.jpg");
    expect(txt).toContain('"@type": "LocalBusiness"');
  });

  it("gera arquivo compactado contendo INFORMACOES-DO-NEGOCIO.txt e todas as fotos baixadas na pasta fotos/", async () => {
    const fakeJpeg = Buffer.alloc(1500, 0xff);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null),
      },
      arrayBuffer: async () =>
        fakeJpeg.buffer.slice(fakeJpeg.byteOffset, fakeJpeg.byteOffset + fakeJpeg.byteLength),
    }) as unknown as typeof fetch;

    const kit = await buildLeadMapsKitArchive({
      lead: {
        id: 99,
        nome_negocio: "Padaria Estrela",
        ramo_negocio: "Padaria",
        telefone: "11988887777",
        endereco: "Rua Augusta, 500 - Consolação, São Paulo - SP",
        maps_url: "https://www.google.com/maps/place/Padaria+Estrela",
        opening_hours: { "segunda-feira": "06:00–22:00" },
        photos: [
          "https://lh3.googleusercontent.com/p/AF1QipPhotoA",
          "https://lh3.googleusercontent.com/p/AF1QipPhotoB",
        ],
      },
      skipLiveScrape: true,
      fetchImpl: mockFetch,
    });

    expect(kit.fileName).toBe("kit-site-padaria-estrela.zip");
    expect(kit.photoCount).toBe(2);

    const zip = await JSZip.loadAsync(kit.buffer);
    const txtFile = zip.file("INFORMACOES-DO-NEGOCIO.txt");
    const foto1 = zip.file("fotos/foto-01.jpg");
    const foto2 = zip.file("fotos/foto-02.jpg");

    expect(txtFile).not.toBeNull();
    expect(foto1).not.toBeNull();
    expect(foto2).not.toBeNull();

    const txtContent = await txtFile!.async("string");
    expect(txtContent).toContain("Padaria Estrela");
    expect(txtContent).toContain("06:00–22:00");
    expect(txtContent).toContain("https://www.google.com/maps/place/Padaria+Estrela");
  });
});

