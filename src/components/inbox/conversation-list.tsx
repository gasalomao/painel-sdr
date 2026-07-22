"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import {
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  resyncToken?: number;
  clientId: string | null;
  activeInstance?: string;
  activeAgentId?: string;
  instances?: any[];
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-emerald-500", // Aberta (bot_paused)
  pending: "bg-amber-500", // Robô (bot_active)
  closed: "bg-muted-foreground", // Fechado
};

type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  clientId,
  activeInstance = "__all__",
  activeAgentId = "__all__",
  instances = [],
}: ConversationListProps) {
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: "Todos", value: "all" },
    { label: "Não lidos", value: "unread" },
    { label: "Humano (Pausados)", value: "open" },
    { label: "Robô (Ativos)", value: "pending" },
    { label: "Fechados", value: "closed" },
  ], []);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  
  // As tags são computadas dinamicamente a partir dos contatos carregados
  const tags = useMemo(() => {
    const uniqueTagNames = new Set<string>();
    for (const c of conversations) {
      if (c.contact?.tags) {
        for (const t of c.contact.tags) {
          uniqueTagNames.add(t.name);
        }
      }
    }
    return Array.from(uniqueTagNames).map((tName) => ({
      id: tName,
      name: tName,
      color: "#3b82f6",
      user_id: clientId || "",
      created_at: new Date().toISOString()
    }));
  }, [conversations, clientId]);

  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;

    (async () => {
      // Executa as duas consultas EM PARALELO com limites otimizados para máxima velocidade.
      // Sessões select * é pesado (inclui variables/JSONB) — pedimos só o necessário.
      // Sem isso, em clientes com 80k+ sessões o chat demorava ~5-10s pra abrir.
      const [sessionsRes, msgsRes] = await Promise.all([
        supabase
          .from("sessions")
          .select("id, client_id, contact_id, instance_name, bot_status, resume_at, unread_count, last_message_at, created_at, updated_at, agent_id, contact:contacts(*)")
          .eq("client_id", clientId)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(100),
        supabase
          .from("chats_dashboard")
          .select("remote_jid, content, created_at")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(300),
      ]);

      if (cancelled) return;

      if (sessionsRes.error) {
        console.error("Falha ao buscar sessões do chat:", sessionsRes.error);
        setLoading(false);
        return;
      }

      const latestMap = new Map<string, { content: string; created_at: string }>();
      if (msgsRes.data) {
        for (const msg of msgsRes.data) {
          if (msg.remote_jid && !latestMap.has(msg.remote_jid)) {
            latestMap.set(msg.remote_jid, {
              content: msg.content || "",
              created_at: msg.created_at
            });
          }
        }
      }

      const normalized = normalizeConversations(sessionsRes.data ?? []).map((c) => {
        const lastMsgObj = latestMap.get(c.id);
        return {
          ...c,
          last_message_text: lastMsgObj?.content || c.last_message_text || "",
          last_message_at: lastMsgObj?.created_at || c.last_message_at,
        };
      });

      onConversationsLoadedRef.current(normalized);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [resyncToken, clientId]);

  // Empresas extraídas derivam das conversas carregadas
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    // Filtro por Instância do WhatsApp ativa
    if (activeInstance && activeInstance !== "__all__") {
      const targetInst = instances.find((i) => i.instance_name === activeInstance);
      const rawPhone = targetInst?.phone_number || targetInst?.owner_phone;
      const cleanPhone = rawPhone ? String(rawPhone).replace(/\D/g, "") : "";

      result = result.filter((c: any) => {
        if (c.last_instance === activeInstance || c.instance_name === activeInstance) return true;
        if (cleanPhone && (c.last_instance === `phone:${cleanPhone}` || c.instance_name === `phone:${cleanPhone}`)) return true;
        if (cleanPhone && c.contact?.phone && String(c.contact.phone).replace(/\D/g, "").includes(cleanPhone)) return true;
        return false;
      });
    }

    // Filtro por Agente de IA atribuído
    if (activeAgentId && activeAgentId !== "__all__") {
      result = result.filter((c: any) => {
        if (String(c.assigned_agent_id) === String(activeAgentId)) return true;
        if (String(c.agent_id) === String(activeAgentId)) return true;

        // Se a instância vinculada à sessão pertence a este agente de IA
        const instObj = instances.find((i) => i.instance_name === c.last_instance || i.instance_name === c.instance_name);
        if (instObj && String(instObj.agent_id) === String(activeAgentId)) return true;

        return false;
      });
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Filtros baseados em tags e empresas
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany, activeInstance, activeAgentId, instances]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80 shrink-0">
      {/* Pesquisa + Filtros */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Buscar contatos ou mensagens..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted outline-none">
                {activeFilter?.label ?? "Todos"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm cursor-pointer",
                    filter === opt.value
                      ? "text-primary font-medium"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted outline-none",
                  selectedTagIds.length > 0
                    ? "text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-primary"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted outline-none",
                  selectedCompany
                    ? "text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Empresa"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm cursor-pointer",
                    selectedCompany === null
                      ? "text-primary font-medium"
                      : "text-popover-foreground"
                  )}
                >
                  Todas empresas
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm cursor-pointer",
                      selectedCompany === co
                        ? "text-primary font-medium"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70 cursor-pointer"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? "Tags"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70 cursor-pointer"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Limpar filtros
            </button>
          </div>
        )}
      </div>

      {/* Lista de conversas */}
      <ScrollArea className="min-h-0 flex-1">
        {loading && conversations.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">Nenhuma conversa encontrada.</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv, idx) => (
              <ConversationItem
                key={`${conv.id}-${idx}`}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Desconhecido";
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = useMemo(() => {
    if (!conversation.last_message_at) return "";
    try {
      return formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: ptBR
      });
    } catch {
      return "";
    }
  }, [conversation.last_message_at]);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50 border-b border-border/40 cursor-pointer",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground relative">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Detalhes */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground flex-1">
            {conversation.last_message_text || "Nenhuma mensagem..."}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full border border-card shadow-sm",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status === "open" ? "Humano (Pausado)" : (conversation.status === "pending" ? "Robô (Ativo)" : "Fechado")}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
