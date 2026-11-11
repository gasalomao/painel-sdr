import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// MOCKS PARA SIMULAÇÃO COMPLETA
// ============================================================

export const mockDb: Record<string, any[]> = {
  whatsapp_warmup_configs: [],
  whatsapp_warmup_groups: [],
  whatsapp_warmup_group_members: [],
  whatsapp_warmup_conversations: [],
  whatsapp_warmup_logs: [],
};

function getTable(table: string): any[] {
  const clean = table.replace("public.", "");
  if (!mockDb[clean]) mockDb[clean] = [];
  return mockDb[clean];
}

vi.mock("@/lib/supabase_admin", () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        const filters: Array<{ col: string; val: any; op: string }> = [];

        const queryBuilder: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col: string, val: any) => {
            filters.push({ col, val, op: "eq" });
            return queryBuilder;
          }),
          in: vi.fn((col: string, val: any) => {
            filters.push({ col, val, op: "in" });
            return queryBuilder;
          }),
          lte: vi.fn((col: string, val: any) => {
            filters.push({ col, val, op: "lte" });
            return queryBuilder;
          }),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => {
            const list = getTable(table);
            const filtered = list.filter((item: any) =>
              filters.every((f) => {
                if (f.op === "eq") return item[f.col] === f.val;
                if (f.op === "in") return f.val.includes(item[f.col]);
                if (f.op === "lte") return item[f.col] <= f.val;
                return true;
              })
            );
            return { data: filtered[0] || null, error: null };
          }),
          single: vi.fn(async () => {
            const list = getTable(table);
            const filtered = list.filter((item: any) =>
              filters.every((f) => {
                if (f.op === "eq") return item[f.col] === f.val;
                if (f.op === "in") return f.val.includes(item[f.col]);
                if (f.op === "lte") return item[f.col] <= f.val;
                return true;
              })
            );
            return { data: filtered[0] || null, error: null };
          }),
          insert: vi.fn(async (rows: any) => {
            const list = getTable(table);
            const arr = Array.isArray(rows) ? rows : [rows];
            for (const r of arr) {
              const item = { id: r.id || `id-${Math.random()}`, created_at: new Date().toISOString(), ...r };
              list.push(item);
            }
            return { data: arr[0], error: null };
          }),
          upsert: vi.fn(async (rows: any) => {
            const list = getTable(table);
            const arr = Array.isArray(rows) ? rows : [rows];
            for (const r of arr) {
              const existingIdx = list.findIndex(
                (item: any) =>
                  (r.instance_name && item.instance_name === r.instance_name) ||
                  (r.invite_code && item.invite_code === r.invite_code) ||
                  (r.id && item.id === r.id)
              );
              if (existingIdx >= 0) {
                list[existingIdx] = { ...list[existingIdx], ...r };
              } else {
                list.push({ id: r.id || `id-${Math.random()}`, created_at: new Date().toISOString(), ...r });
              }
            }
            return { data: arr[0], error: null };
          }),
          update: vi.fn((updates: any) => {
            const updateBuilder: any = {
              eq: vi.fn((col: string, val: any) => {
                filters.push({ col, val, op: "eq" });
                return updateBuilder;
              }),
              then: (resolve: any) => {
                const list = getTable(table);
                for (const item of list) {
                  const match = filters.length === 0 || filters.every((f) => item[f.col] === f.val);
                  if (match) {
                    Object.assign(item, updates);
                  }
                }
                resolve({ data: null, error: null });
              },
            };
            return updateBuilder;
          }),
          delete: vi.fn(() => {
            const deleteBuilder: any = {
              eq: vi.fn((col: string, val: any) => {
                filters.push({ col, val, op: "eq" });
                return deleteBuilder;
              }),
              then: (resolve: any) => {
                const list = getTable(table);
                const remaining = list.filter((item: any) =>
                  !filters.every((f) => item[f.col] === f.val)
                );
                const clean = table.replace("public.", "");
                mockDb[clean] = remaining;
                resolve({ data: null, error: null });
              },
            };
            return deleteBuilder;
          }),
          then: (resolve: any) => {
            const list = getTable(table);
            let filtered = list;
            if (filters.length > 0) {
              filtered = list.filter((item: any) =>
                filters.every((f) => {
                  if (f.op === "eq") return item[f.col] === f.val;
                  if (f.op === "in") return f.val.includes(item[f.col]);
                  if (f.op === "lte") return item[f.col] <= f.val;
                  return true;
                })
              );
            }
            resolve({ data: filtered, error: null });
          },
        };

        return queryBuilder;
      },
    },
  };
});

const mockEvolutionCalls: {
  reactions: any[];
  joinedGroups: any[];
  leftGroups: any[];
  statuses: any[];
  messages: any[];
} = {
  reactions: [],
  joinedGroups: [],
  leftGroups: [],
  statuses: [],
  messages: [],
};

vi.mock("@/lib/evolution", () => {
  return {
    evolution: {
      getGroupInviteInfo: vi.fn(async (code: string) => {
        return {
          id: `120363000${code.slice(0, 5)}@g.us`,
          subject: `Grupo Teste ${code.slice(0, 4)}`,
          size: 150,
          desc: "Grupo de teste automatizado",
        };
      }),
      acceptGroupInvite: vi.fn(async (code: string, instance: string) => {
        const groupJid = `120363000${code.slice(0, 5)}@g.us`;
        mockEvolutionCalls.joinedGroups.push({ code, instance, groupJid });
        return { success: true, groupJid };
      }),
      leaveGroup: vi.fn(async (groupJid: string, instance: string) => {
        mockEvolutionCalls.leftGroups.push({ groupJid, instance });
        return true;
      }),
      sendReaction: vi.fn(async (remoteJid: string, messageId: string, reaction: string, instance: string, _fromMe = false, participant?: string) => {
        mockEvolutionCalls.reactions.push({ remoteJid, messageId, reaction, instance, participant });
        return { success: true };
      }),
      updateProfileStatus: vi.fn(async (status: string, instance: string) => {
        mockEvolutionCalls.statuses.push({ status, instance });
        return true;
      }),
      sendStatus: vi.fn(async () => true),
      markMessageAsRead: vi.fn(async () => true),
      sendPresence: vi.fn(async () => true),
      sendContact: vi.fn(async () => true),
      sendTextMessage: vi.fn(async () => true),
      sendVoiceRecording: vi.fn(async () => true),
      findSettings: vi.fn(async () => ({})),
      fetchInstances: vi.fn(async () => []),
    },
  };
});

describe("Validação Ponta a Ponta: Colmeia N-Chips & Grupos de Aquecimento", () => {
  const CLIENT_ID = "00000000-0000-0000-0000-000000000001";

  beforeEach(() => {
    mockDb.whatsapp_warmup_configs = [];
    mockDb.whatsapp_warmup_groups = [];
    mockDb.whatsapp_warmup_group_members = [];
    mockDb.whatsapp_warmup_conversations = [];
    mockDb.whatsapp_warmup_logs = [];

    mockEvolutionCalls.reactions = [];
    mockEvolutionCalls.joinedGroups = [];
    mockEvolutionCalls.leftGroups = [];
    mockEvolutionCalls.statuses = [];
    mockEvolutionCalls.messages = [];
  });

  describe("1. Importação em Lote de Grupos e Entrada Escalonada", () => {
    it("importa múltiplos links de grupos de uma vez só", async () => {
      const { importWarmupGroups } = await import("../warmup-groups");
      const input = `
        https://chat.whatsapp.com/G34A1B2C3D4E5F6G7H8I9J
        https://chat.whatsapp.com/L99Z8Y7X6W5V4U3T2S1R0Q
        https://chat.whatsapp.com/M55P4Q3R2S1T0U9V8W7X6Y
      `;

      const res = await importWarmupGroups(CLIENT_ID, input, "inst-alpha");
      expect(res.added).toBe(3);
      expect(res.totalParsed).toBe(3);
      expect(mockDb.whatsapp_warmup_groups.length).toBe(3);

      const first = mockDb.whatsapp_warmup_groups[0];
      expect(first.invite_code).toBe("G34A1B2C3D4E5F6G7H8I9J");
      expect(first.name).toContain("Grupo Teste");
    });

    it("ignora grupos já cadastrados evitando duplicação", async () => {
      const { importWarmupGroups } = await import("../warmup-groups");
      const input = "https://chat.whatsapp.com/DUPLICADO123456789012";

      // 1ª importação
      const r1 = await importWarmupGroups(CLIENT_ID, input, "inst-alpha");
      expect(r1.added).toBe(1);

      // 2ª importação do mesmo link
      const r2 = await importWarmupGroups(CLIENT_ID, input, "inst-alpha");
      expect(r2.added).toBe(0);
      expect(r2.existing).toBe(1);
    });

    it("sincroniza a adesão de todos os chips ativos nos grupos", async () => {
      const { importWarmupGroups, syncGroupMembershipForChips } = await import("../warmup-groups");

      // Adiciona 2 chips na colmeia
      mockDb.whatsapp_warmup_configs.push(
        { client_id: CLIENT_ID, instance_name: "chip-1", enabled: true, is_quarantined: false, group_auto_join: true },
        { client_id: CLIENT_ID, instance_name: "chip-2", enabled: true, is_quarantined: false, group_auto_join: true }
      );

      // Importa 2 grupos
      await importWarmupGroups(CLIENT_ID, "https://chat.whatsapp.com/GRUPO_A1234567890123\nhttps://chat.whatsapp.com/GRUPO_B1234567890123");

      const syncRes = await syncGroupMembershipForChips(CLIENT_ID);
      expect(syncRes.joinedCount).toBe(4); // 2 chips x 2 grupos = 4 adesões
      expect(mockEvolutionCalls.joinedGroups).toHaveLength(4);
    });
  });

  describe("2. Camada Zero-Token de Grupos (Heurística de Sentimentos)", () => {
    it("reage automaticamente com 👍/☕ em saudações de bom dia sem gastar tokens", async () => {
      const { processIncomingGroupMessage } = await import("../warmup-groups");

      const groupJid = "12036399999999@g.us";
      mockDb.whatsapp_warmup_groups.push({
        id: "grp-1",
        client_id: CLIENT_ID,
        group_jid: groupJid,
        invite_code: "ABC1234567890123456789",
        status: "active",
      });

      // Forçamos Math.random para garantir acerto na heurística
      const origRandom = Math.random;
      Math.random = () => 0.05; // menor que 0.25 (dispara reação)

      const res = await processIncomingGroupMessage({
        clientId: CLIENT_ID,
        instanceName: "chip-alpha",
        groupJid,
        messageId: "msg-12345",
        messageText: "Bom dia pessoal, uma semana abençoada a todos!",
        participant: "5511999999999@s.whatsapp.net",
      });

      Math.random = origRandom;

      expect(res.handled).toBe(true);
      expect(res.action).toBe("reacted");
      expect(["👍", "☀️", "☕", "👋", "🙏"]).toContain(res.reaction);
    });

    it("reage com 👏/🚀/🎉 em celebrações e conquistas", async () => {
      const { processIncomingGroupMessage } = await import("../warmup-groups");

      const groupJid = "12036388888888@g.us";
      mockDb.whatsapp_warmup_groups.push({
        id: "grp-2",
        client_id: CLIENT_ID,
        group_jid: groupJid,
        invite_code: "DEF1234567890123456789",
        status: "active",
      });

      const origRandom = Math.random;
      Math.random = () => 0.05;

      const res = await processIncomingGroupMessage({
        clientId: CLIENT_ID,
        instanceName: "chip-beta",
        groupJid,
        messageId: "msg-67890",
        messageText: "Parabéns equipe, meta batida com sucesso!",
        participant: "5521999999999@s.whatsapp.net",
      });

      Math.random = origRandom;

      expect(res.handled).toBe(true);
      expect(res.action).toBe("reacted");
      expect(["👏", "🚀", "🎉", "💪", "🔥"]).toContain(res.reaction);
    });

    it("ignora mensagens enviadas pelo próprio chip (fromMe = true)", async () => {
      const { processIncomingGroupMessage } = await import("../warmup-groups");

      const res = await processIncomingGroupMessage({
        clientId: CLIENT_ID,
        instanceName: "chip-alpha",
        groupJid: "12036377777777@g.us",
        messageId: "msg-self",
        messageText: "Bom dia galera",
        fromMe: true,
      });

      expect(res.handled).toBe(true);
      expect(res.action).toBe("ignored_from_me");
      expect(res.reaction).toBeUndefined();
    });
  });

  describe("3. Piloto Automático da Colmeia (Swarm Mesh para N Números)", () => {
    it("ativa todos os chips conectados simultaneamente com 1 clique (enableSwarmAutopilot)", async () => {
      const { enableSwarmAutopilot } = await import("../warmup-worker");

      // Cadastra 3 chips desligados
      mockDb.whatsapp_warmup_configs.push(
        { client_id: CLIENT_ID, instance_name: "alpha", enabled: false },
        { client_id: CLIENT_ID, instance_name: "beta", enabled: false },
        { client_id: CLIENT_ID, instance_name: "gamma", enabled: false }
      );

      const res = await enableSwarmAutopilot(CLIENT_ID);
      expect(res.success).toBe(true);
      expect(res.chipsActivated).toBe(3);

      // Todos os 3 chips devem estar habilitados com swarm_active e proteções
      for (const c of mockDb.whatsapp_warmup_configs) {
        expect(c.enabled).toBe(true);
        expect(c.swarm_active).toBe(true);
        expect(c.group_auto_join).toBe(true);
      }
    });

    it("hidrata automaticamente perfis de chips novos no Dia 1", async () => {
      const { hydrateChipProfile } = await import("../warmup-groups");

      mockDb.whatsapp_warmup_configs.push({
        client_id: CLIENT_ID,
        instance_name: "novo-chip",
        profile_hydrated: false,
      });

      const res = await hydrateChipProfile(CLIENT_ID, "novo-chip");
      expect(res.success).toBe(true);
      expect(mockEvolutionCalls.statuses.length).toBeGreaterThan(0);
      expect(mockEvolutionCalls.statuses[0].instance).toBe("novo-chip");
    });
  });
});
