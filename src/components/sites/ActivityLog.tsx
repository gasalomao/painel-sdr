/**
 * Componente React completo para exibir activity logs
 * Estilo Lovable - mostra em tempo real o que o agent está fazendo
 */

"use client";

import React from "react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

interface ActivityEvent {
  id: string;
  type: string;
  message: string;
  status?: "pending" | "success" | "error";
  details?: any;
  duration?: number;
  timestamp: number;
}

interface ActivityLogProps {
  runId: string;
  className?: string;
}

export function ActivityLog({ runId, className = "" }: ActivityLogProps) {
  const [activities, setActivities] = React.useState<ActivityEvent[]>([]);
  const [isLive, setIsLive] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const eventSourceRef = React.useRef<EventSource | null>(null);

  // Carrega atividades e conecta ao stream
  React.useEffect(() => {
    if (!runId) return;

    loadActivities();
    connectStream();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [runId]);

  // Auto-scroll para última atividade
  React.useEffect(() => {
    if (scrollRef.current && activities.length > 0) {
      const shouldScroll =
        scrollRef.current.scrollHeight - scrollRef.current.scrollTop <=
        scrollRef.current.clientHeight + 100;

      if (shouldScroll) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [activities]);

  async function loadActivities() {
    try {
      const response = await fetch(`/api/sites/runs/${runId}/activities`);
      const data = await response.json();
      setActivities(data.activities || []);
      setIsLoading(false);
    } catch (error) {
      console.error("Failed to load activities:", error);
      setIsLoading(false);
    }
  }

  function connectStream() {
    try {
      const eventSource = new EventSource(
        `/api/sites/runs/${runId}/activities?stream=true`
      );

      eventSource.onmessage = (event) => {
        const activity: ActivityEvent = JSON.parse(event.data);
        setActivities((prev) => {
          // Evita duplicatas
          if (prev.some((a) => a.id === activity.id)) {
            return prev;
          }
          return [...prev, activity];
        });
      };

      eventSource.onerror = () => {
        setIsLive(false);
        eventSource.close();
      };

      eventSourceRef.current = eventSource;
    } catch (error) {
      console.error("Failed to connect stream:", error);
      setIsLive(false);
    }
  }

  if (isLoading) {
    return (
      <div className={`activity-log ${className}`}>
        <div className="activity-log-header">
          <h3>Atividade</h3>
        </div>
        <div className="activity-log-loading">
          <div className="spinner" />
          <p>Carregando atividades...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`activity-log ${className}`}>
      <div className="activity-log-header">
        <h3>Atividade</h3>
        {isLive && (
          <div className="live-indicator">
            <span className="live-dot" />
            <span className="live-text">Ao vivo</span>
          </div>
        )}
      </div>

      <div className="activity-log-content" ref={scrollRef}>
        {activities.length === 0 ? (
          <div className="activity-log-empty">
            <p>Nenhuma atividade ainda...</p>
          </div>
        ) : (
          activities.map((activity, index) => (
            <ActivityItem
              key={activity.id}
              activity={activity}
              isLast={index === activities.length - 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ActivityItem({
  activity,
  isLast,
}: {
  activity: ActivityEvent;
  isLast: boolean;
}) {
  const icon = getActivityIcon(activity.type, activity.status);
  const statusClass = activity.status ? `status-${activity.status}` : "";
  const isPending = activity.status === "pending";

  return (
    <div className={`activity-item ${statusClass} ${isLast ? "is-last" : ""}`}>
      <div className={`activity-icon ${isPending ? "pending" : ""}`}>
        {icon}
      </div>
      <div className="activity-content">
        <div className="activity-message">{activity.message}</div>
        <div className="activity-meta">
          {activity.duration && (
            <span className="activity-duration">
              {formatDuration(activity.duration)}
            </span>
          )}
          {activity.details && Object.keys(activity.details).length > 0 && (
            <ActivityDetails details={activity.details} />
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityDetails({ details }: { details: any }) {
  const [isExpanded, setIsExpanded] = React.useState(false);

  // Formata detalhes importantes
  const summary = getDetailsSummary(details);
  if (!summary) return null;

  return (
    <div className="activity-details">
      <button
        className="activity-details-toggle"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {summary}
        <svg
          className={`activity-details-chevron ${isExpanded ? "expanded" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {isExpanded && (
        <pre className="activity-details-content">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function getDetailsSummary(details: any): string | null {
  if (!details) return null;

  // Tool params
  if (details.toolName && details.params) {
    const paramKeys = Object.keys(details.params);
    if (paramKeys.length > 0) {
      return `${paramKeys.length} parâmetro(s)`;
    }
  }

  // Model usage
  if (details.usage) {
    const { inputTokens, outputTokens } = details.usage;
    if (inputTokens && outputTokens) {
      return `${inputTokens} → ${outputTokens} tokens`;
    }
  }

  // Validation result
  if (details.result && typeof details.result.passed === "boolean") {
    return `${details.result.errors?.length || 0} erro(s), ${details.result.warnings?.length || 0} aviso(s)`;
  }

  return null;
}

function getActivityIcon(type: string, status?: string): string {
  if (status === "error") return "❌";
  if (status === "success" && !type.includes("start")) return "✅";

  switch (type) {
    case "tool_start":
    case "tool_complete":
      return "🔧";
    case "model_start":
    case "model_complete":
      return "🤖";
    case "model_thinking":
      return "💭";
    case "validation_start":
    case "validation_complete":
      return "🔍";
    case "build_start":
    case "build_progress":
    case "build_complete":
      return "🔨";
    case "checkpoint_created":
      return "💾";
    case "revision_created":
      return "✏️";
    case "thinking":
      return "🧠";
    case "planning":
      return "📋";
    case "design_analysis":
      return "🎨";
    case "file_created":
      return "✨";
    case "file_updated":
      return "💾";
    case "info":
      return "ℹ️";
    default:
      return "⚙️";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// ==================== STYLES ====================

const styles = `
.activity-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-surface-1);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}

.activity-log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-2);
}

.activity-log-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.live-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-success);
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-success);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.activity-log-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.activity-log-loading,
.activity-log-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.activity-item {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  animation: fadeIn 0.2s ease-in;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.activity-item.is-last {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}

.activity-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.activity-icon.pending {
  animation: pulse 2s ease-in-out infinite;
}

.activity-content {
  flex: 1;
  min-width: 0;
}

.activity-message {
  font-size: 13px;
  color: var(--color-text-primary);
  line-height: 1.5;
}

.activity-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.activity-duration {
  font-variant-numeric: tabular-nums;
}

.activity-details-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface-2);
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.activity-details-toggle:hover {
  background: var(--color-surface-3);
  border-color: var(--color-border-hover);
}

.activity-details-chevron {
  transition: transform 0.2s;
}

.activity-details-chevron.expanded {
  transform: rotate(180deg);
}

.activity-details-content {
  margin-top: 8px;
  padding: 8px;
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 11px;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  color: var(--color-text-primary);
  overflow-x: auto;
}

.status-error .activity-message {
  color: var(--color-error);
}

.status-success .activity-message {
  color: var(--color-text-primary);
}

.status-pending .activity-message {
  color: var(--color-text-secondary);
}
`;

// Inject styles
if (typeof document !== "undefined") {
  const styleTag = document.createElement("style");
  styleTag.textContent = styles;
  document.head.appendChild(styleTag);
}
