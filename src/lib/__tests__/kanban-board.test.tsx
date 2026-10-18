import type { ComponentProps, ReactNode } from "react";
import type { CollisionDetection, DndContextProps, DragCancelEvent, DragEndEvent, DragStartEvent, UniqueIdentifier } from "@dnd-kit/core";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dnd: {} as DndContextProps,
  droppableNodes: new Map<UniqueIdentifier, HTMLElement>(),
  from: vi.fn(),
  clientId: "tenant-fixture" as string | null,
  sessionLoading: false,
}));

// Exercise the board's handlers and real React state, not dnd-kit's sensors/layout.
vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@dnd-kit/core")>(),
  DndContext: (props: DndContextProps) => {
    mocks.dnd = props;
    return <>{props.children}</>;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => <div data-testid="drag-overlay">{children}</div>,
  useDroppable: ({ id }: { id: UniqueIdentifier }) => ({
    setNodeRef: (node: HTMLElement | null) => {
      if (node) mocks.droppableNodes.set(id, node);
      else mocks.droppableNodes.delete(id);
    },
    isOver: false,
    active: null,
    over: null,
    rect: { current: null },
  }),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  horizontalListSortingStrategy: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@/lib/use-session", () => ({
  useClientSession: () => ({
    clientId: mocks.clientId,
    loading: mocks.sessionLoading,
    session: mocks.clientId ? { authenticated: true, clientId: mocks.clientId } : null,
  }),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));

import KanbanBoard, { type KanbanColumnDef } from "@/app/leads/_components/KanbanBoard";

type Lead = ComponentProps<typeof KanbanBoard>["leads"][number];
type WriteResult = { data: { id: number } | null; error: { message: string } | null };
type Write = {
  table: string;
  values: Record<string, unknown>;
  filters: [string, unknown][];
  returning?: string;
  cardinality?: "single" | "maybeSingle";
};

const columns: KanbanColumnDef[] = [
  { id: "novo", uuid: "column-uuid-1", label: "Novos", color: "#3b82f6" },
  { id: "em_contato", uuid: "column-uuid-2", label: "Em contato", color: "#f59e0b" },
  { id: "ganho", uuid: "column-uuid-3", label: "Ganhos", color: "#22c55e", isTerminal: true },
];
const writes: Write[] = [];
const outcomes: (() => Promise<WriteResult>)[] = [];

function lead(id: number, nome_negocio: string, status: string): Lead {
  return {
    id, nome_negocio, status,
    remoteJid: `551199999000${id}@s.whatsapp.net`, telefone: `1199999000${id}`,
    ramo_negocio: "Serviços", endereco: "Rua das Flores, 10", rating: "", reviews: "",
    website: "", instagram: "", facebook: "", maps_url: "",
    next_follow_up: null, justificativa_ia: null, resumo_ia: null, ia_last_analyzed_at: null,
    created_at: "2026-10-01T12:00:00Z", primeiro_contato_source: null, primeiro_contato_at: null,
  };
}

function mountBoard() {
  const leads = [
    lead(1, "Oficina Aurora", "novo"),
    lead(2, "Padaria Boreal", "em_contato"),
    lead(3, "Mercado Cedro", "novo"),
  ];
  const onLeadsUpdated = vi.fn();
  render(<KanbanBoard leads={leads} columns={columns} onLeadClick={vi.fn()}
    formatPhone={(jid) => jid} onLeadsUpdated={onLeadsUpdated} />);
  return { onLeadsUpdated };
}

// Locate a card by visible content and its column label, without depending on CSS
// classes, hook state, or how the optimistic update/rollback is implemented.
function statusOf(name: string): string | undefined {
  const overlay = screen.getByTestId("drag-overlay");
  let node: HTMLElement | null = screen.getAllByText(name).find((item) => !overlay.contains(item)) ?? null;
  while (node) {
    const column = columns.find(({ label }) => within(node!).queryByRole("button", { name: label, exact: true }));
    if (column) return column.id;
    node = node.parentElement;
  }
  return undefined;
}

function lastStatuses(callback: ReturnType<typeof vi.fn>): Record<number, string> {
  const leads = callback.mock.lastCall?.[0] as Lead[] | undefined;
  return Object.fromEntries((leads ?? []).map(({ id, status }) => [id, status]));
}

function drop(id: number, over: UniqueIdentifier | null): Promise<unknown> {
  let completion: unknown;
  act(() => {
    completion = mocks.dnd.onDragEnd?.({ active: { id }, over: over === null ? null : { id: over } } as DragEndEvent);
  });
  const pending = Promise.resolve(completion);
  // Observe failures immediately so the rejection test can report the escaped
  // error explicitly instead of producing an unrelated unhandled rejection.
  void pending.catch(() => undefined);
  return pending;
}

async function finish(pending: Promise<unknown>): Promise<void> {
  await act(async () => { await pending; });
}

function deferredWrite() {
  let resolve!: (value: WriteResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<WriteResult>((res, rej) => { resolve = res; reject = rej; });
  outcomes.push(() => promise);
  return { resolve, reject };
}

function expectPortugueseAlert(): void {
  expect(screen.getByRole("alert")).toHaveTextContent(/não|erro\b|falh[ao]|tente novamente/i);
}

beforeEach(() => {
  mocks.dnd = {};
  mocks.droppableNodes.clear();
  mocks.clientId = "tenant-fixture";
  mocks.sessionLoading = false;
  writes.length = 0;
  outcomes.length = 0;
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: false, media, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Requisição externa proibida neste teste"); }));

  // A thenable query accepts the current await(eq(...)) and the fixed
  // eq(...).eq(...).select(...).single()/maybeSingle(), without prescribing order.
  mocks.from.mockImplementation((table: string) => ({
    update: (values: Record<string, unknown>) => {
      const write: Write = { table, values, filters: [] };
      writes.push(write);
      const response = outcomes.shift()?.() ?? Promise.resolve().then(() => ({
        data: { id: Number(write.filters.find(([key]) => key === "id")?.[1]) }, error: null,
      }));
      const query = {
        eq: (key: string, value: unknown) => { write.filters.push([key, value]); return query; },
        select: (projection: string) => { write.returning = projection; return query; },
        single: () => { write.cardinality = "single"; return query; },
        maybeSingle: () => { write.cardinality = "maybeSingle"; return query; },
        then: response.then.bind(response),
      };
      return query;
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KanbanBoard — destino do arraste", () => {
  it("registra também a coluna vazia como droppable pelo status_key, não pelo UUID", () => {
    mountBoard();
    const empty = screen.getByText("Vazio — arraste aqui");
    expect(mocks.droppableNodes.get("ganho")).toBeInstanceOf(HTMLElement);
    expect(mocks.droppableNodes.get("ganho")).toContainElement(empty);
    for (const column of columns) {
      expect(mocks.droppableNodes.get(column.id)).toBeInstanceOf(HTMLElement);
      expect(mocks.droppableNodes.has(column.uuid)).toBe(false);
    }
  });

  it("mantém o cartão na coluna antes vazia ao soltar sobre seu destino registrado", async () => {
    const { onLeadsUpdated } = mountBoard();
    // No sensor can report a column as `over` if it never registered a DOM node.
    const target = mocks.droppableNodes.has("ganho") ? "ganho" : null;
    await finish(drop(1, target));
    expect(statusOf("Oficina Aurora")).toBe("ganho");
    expect(lastStatuses(onLeadsUpdated)[1]).toBe("ganho");
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toEqual({ status: "ganho" });
  });

  it("usa o status do cartão de destino ao soltar em uma coluna ocupada", async () => {
    const { onLeadsUpdated } = mountBoard();
    await finish(drop(1, 2));
    expect(statusOf("Oficina Aurora")).toBe("em_contato");
    expect(statusOf("Padaria Boreal")).toBe("em_contato");
    expect(lastStatuses(onLeadsUpdated)).toEqual({ 1: "em_contato", 2: "em_contato", 3: "novo" });
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toEqual({ status: "em_contato" });
  });

  it.each([
    ["fora do quadro", null],
    ["em destino desconhecido", "destino-inexistente"],
    ["na própria coluna", "novo"],
    ["sobre si mesmo", 1],
    ["sobre outro cartão do mesmo status", 3],
  ] as const)("não altera nem persiste ao soltar %s", async (_description, target) => {
    const { onLeadsUpdated } = mountBoard();
    await finish(drop(1, target));
    expect(statusOf("Oficina Aurora")).toBe("novo");
    expect(statusOf("Padaria Boreal")).toBe("em_contato");
    expect(writes).toHaveLength(0);
    expect(onLeadsUpdated).not.toHaveBeenCalled();
  });

  it("limpa o overlay quando Escape cancela o arraste (onDragCancel)", () => {
    const { onLeadsUpdated } = mountBoard();
    act(() => { mocks.dnd.onDragStart?.({ active: { id: 1 } } as DragStartEvent); });
    const overlay = screen.getByTestId("drag-overlay");
    expect(within(overlay).getByText("Oficina Aurora")).toBeInTheDocument();
    act(() => {
      mocks.dnd.onDragCancel?.({
        active: { id: 1 }, over: null,
        activatorEvent: new KeyboardEvent("keydown", { key: "Escape" }),
      } as DragCancelEvent);
    });
    expect(within(overlay).queryByText("Oficina Aurora")).not.toBeInTheDocument();
    expect(statusOf("Oficina Aurora")).toBe("novo");
    expect(writes).toHaveLength(0);
    expect(onLeadsUpdated).not.toHaveBeenCalled();
  });

  function collisions(pointerCoordinates: { x: number; y: number } | null, x: number, y: number) {
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height,
    });
    const ids = ["novo", "ganho", 3];
    const args: Parameters<CollisionDetection>[0] = {
      active: { id: 1, data: { current: {} }, rect: { current: { initial: null, translated: null } } },
      pointerCoordinates,
      collisionRect: rect(x, y, 280, 120),
      droppableRects: new Map([
        ["novo", rect(0, 0, 300, 700)],
        ["ganho", rect(320, 0, 300, 700)],
        [3, rect(0, 570, 280, 120)],
      ]),
      droppableContainers: ids.map((id) => ({
        id, key: String(id), disabled: false, data: { current: {} },
        node: { current: null }, rect: { current: null },
      })),
    };
    return mocks.dnd.collisionDetection?.(args) ?? [];
  }

  it("o ponteiro vence o centro do cartão ao entrar pela borda de uma coluna vazia", () => {
    mountBoard();
    expect(collisions({ x: 321, y: 650 }, 60, 590)[0]?.id).toBe("ganho");
  });

  it("não escolhe uma coluna distante ao soltar fora do quadro", () => {
    mountBoard();
    expect(collisions({ x: 1100, y: 850 }, 900, 790)).toEqual([]);
  });

  it("mantém o destino por interseção para o sensor de teclado sem ponteiro", () => {
    mountBoard();
    expect(collisions(null, 330, 300)[0]?.id).toBe("ganho");
  });
});

describe("KanbanBoard — persistência e concorrência", () => {
  it("mantém a atualização otimista após sucesso e confirma uma linha no tenant da sessão", async () => {
    const response = deferredWrite();
    const { onLeadsUpdated } = mountBoard();
    const pending = drop(1, "ganho");
    expect(statusOf("Oficina Aurora")).toBe("ganho");
    expect(lastStatuses(onLeadsUpdated)[1]).toBe("ganho");
    await act(async () => { response.resolve({ data: { id: 1 }, error: null }); await pending; });
    expect(statusOf("Oficina Aurora")).toBe("ganho");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      table: "leads_extraidos", values: { status: "ganho" },
      filters: expect.arrayContaining([["id", 1], ["client_id", "tenant-fixture"]]),
      returning: expect.stringMatching(/\bid\b/),
      cardinality: expect.stringMatching(/^(single|maybeSingle)$/),
    });
  });

  it.each([true, false])("sem clientId não altera nem persiste, com loading=%s", async (loading) => {
    mocks.clientId = null;
    mocks.sessionLoading = loading;
    const { onLeadsUpdated } = mountBoard();
    await finish(drop(1, "ganho"));
    expect(statusOf("Oficina Aurora")).toBe("novo");
    expect(writes).toHaveLength(0);
    expect(onLeadsUpdated).not.toHaveBeenCalled();
  });

  it.each(["erro retornado", "rejeição da requisição", "zero linhas retornadas"] as const)(
    "reverte o cartão e anuncia em pt-BR em caso de %s", async (failure) => {
      const response = deferredWrite();
      const { onLeadsUpdated } = mountBoard();
      const pending = drop(1, "ganho");
      expect(statusOf("Oficina Aurora")).toBe("ganho");
      let escaped: unknown;
      await act(async () => {
        if (failure === "rejeição da requisição") response.reject(new Error("connection reset"));
        else response.resolve({ data: null, error: failure === "erro retornado" ? { message: "permission denied" } : null });
        await pending.catch((error: unknown) => { escaped = error; });
      });
      expect.soft(escaped, "a falha deve ser tratada pelo quadro").toBeUndefined();
      expect.soft(statusOf("Oficina Aurora")).toBe("novo");
      expect.soft(lastStatuses(onLeadsUpdated)).toEqual({ 1: "novo", 2: "em_contato", 3: "novo" });
      expectPortugueseAlert();
    },
  );

  it("bloqueia outro movimento do mesmo cartão pendente e libera após a confirmação", async () => {
    const response = deferredWrite();
    mountBoard();
    const first = drop(1, "ganho");
    await finish(drop(1, "em_contato"));
    const statusWhilePending = statusOf("Oficina Aurora");
    const writesWhilePending = writes.length;
    await act(async () => { response.resolve({ data: { id: 1 }, error: null }); await first; });
    expect.soft(statusWhilePending).toBe("ganho");
    expect.soft(writesWhilePending).toBe(1);
    expect.soft(statusOf("Oficina Aurora")).toBe("ganho");
    await finish(drop(1, "em_contato"));
    expect(statusOf("Oficina Aurora")).toBe("em_contato");
    expect(writes).toHaveLength(2);
  });

  it("reverte dois cartões quando as gravações falham no mesmo lote, sem render intermediário", async () => {
    const firstResponse = deferredWrite();
    const secondResponse = deferredWrite();
    const { onLeadsUpdated } = mountBoard();
    const first = drop(1, "ganho");
    const second = drop(2, "ganho");
    await act(async () => {
      firstResponse.resolve({ data: null, error: { message: "permission denied" } });
      secondResponse.resolve({ data: null, error: { message: "connection reset" } });
      await Promise.all([first, second]);
    });
    expect(statusOf("Oficina Aurora")).toBe("novo");
    expect(statusOf("Padaria Boreal")).toBe("em_contato");
    expect(lastStatuses(onLeadsUpdated)).toEqual({ 1: "novo", 2: "em_contato", 3: "novo" });
    expectPortugueseAlert();
  });

  it("permite mover outro cartão pendente e não perde seu sucesso no rollback tardio do primeiro", async () => {
    const firstResponse = deferredWrite();
    const secondResponse = deferredWrite();
    const { onLeadsUpdated } = mountBoard();
    const first = drop(1, "ganho");
    const second = drop(2, "ganho");
    const writesWhileFirstPending = writes.length;
    await act(async () => { secondResponse.resolve({ data: { id: 2 }, error: null }); await second; });
    expect(writesWhileFirstPending).toBe(2);
    expect(statusOf("Oficina Aurora")).toBe("ganho");
    expect(statusOf("Padaria Boreal")).toBe("ganho");
    await act(async () => {
      firstResponse.resolve({ data: null, error: { message: "permission denied" } });
      await first;
    });
    expect.soft(statusOf("Oficina Aurora")).toBe("novo");
    expect.soft(statusOf("Padaria Boreal")).toBe("ganho");
    expect.soft(lastStatuses(onLeadsUpdated)).toEqual({ 1: "novo", 2: "ganho", 3: "novo" });
    expectPortugueseAlert();
  });

  it("reconciliação durante arraste pendente preserva o status otimista mas incorpora novos dados como foto", async () => {
    const response = deferredWrite();
    const initialLeads = [
      lead(1, "Oficina Aurora", "novo"),
      lead(2, "Padaria Boreal", "em_contato"),
    ];
    const { rerender } = render(
      <KanbanBoard
        leads={initialLeads}
        columns={columns}
        onLeadClick={vi.fn()}
        formatPhone={(jid) => jid}
        onLeadsUpdated={vi.fn()}
      />
    );

    // Inicia movimento do lead 1 para 'ganho' (fica pendente)
    const pending = drop(1, "ganho");
    expect(statusOf("Oficina Aurora")).toBe("ganho");

    // Parent atualiza leads (ex: foto nova ou nome atualizado)
    const updatedLeads = [
      { ...initialLeads[0], profilePicUrl: "https://img.wa/aurora.jpg", nome_negocio: "Oficina Aurora Renomeada" },
      initialLeads[1],
    ];
    rerender(
      <KanbanBoard
        leads={updatedLeads}
        columns={columns}
        onLeadClick={vi.fn()}
        formatPhone={(jid) => jid}
        onLeadsUpdated={vi.fn()}
      />
    );

    // O status otimista 'ganho' foi mantido, mas o novo nome já aparece!
    expect(statusOf("Oficina Aurora Renomeada")).toBe("ganho");

    // Conclui o salvamento com sucesso
    await act(async () => {
      response.resolve({ data: { id: 1 }, error: null });
      await pending;
    });
    expect(statusOf("Oficina Aurora Renomeada")).toBe("ganho");
  });
});
