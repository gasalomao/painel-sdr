import { activityLogger } from "./activity-logger";
import type { ActivityEvent } from "./activity-logger";
import { useState, useEffect, useRef } from "react";

/**
 * Hook React para consumir activity logs em tempo real
 */
export function useActivityLogs(runId?: string) {
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [isLive, setIsLive] = useState(true);

  useEffect(() => {
    if (!runId) return;

    // Carrega atividades existentes do servidor
    loadActivities(runId);

    // Conecta ao EventSource para receber eventos em tempo real
    const eventSource = new EventSource(`/api/sites/runs/${runId}/activities`);

    eventSource.onmessage = (event) => {
      const activity: ActivityEvent = JSON.parse(event.data);
      setActivities((prev) => [...prev, activity]);
    };

    eventSource.onerror = () => {
      setIsLive(false);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [runId]);

  async function loadActivities(runId: string) {
    const response = await fetch(`/api/sites/runs/${runId}/activities`);
    const data = await response.json();
    setActivities(data.activities || []);
  }

  return {
    activities,
    isLive,
  };
}

/**
 * Componente de visualização de atividades (estilo Lovable)
 */
export function ActivityLog({ runId }: { runId: string }) {
  const { activities, isLive } = useActivityLogs(runId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll para última atividade
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activities]);

  return (
    <div className="activity-log">
      <div className="activity-log-header">
        <h3>Atividade</h3>
        {isLive && <span className="live-indicator">●</span>}
      </div>

      <div className="activity-log-content" ref={scrollRef}>
        {activities.map((activity, index) => (
          <ActivityItem key={activity.id} activity={activity} index={index} />
        ))}
      </div>
    </div>
  );
}

/**
 * Item individual de atividade
 */
function ActivityItem({ activity, index }: { activity: ActivityEvent; index: number }) {
  const icon = getActivityIcon(activity.type, activity.status);
  const statusClass = activity.status ? `status-${activity.status}` : "";

  return (
    <div className={`activity-item ${statusClass}`}>
      <div className="activity-icon">{icon}</div>
      <div className="activity-content">
        <div className="activity-message">{activity.message}</div>
        {activity.duration && (
          <div className="activity-duration">{formatDuration(activity.duration)}</div>
        )}
      </div>
    </div>
  );
}

function getActivityIcon(type: ActivityEvent["type"], status?: ActivityEvent["status"]): string {
  if (status === "error") return "❌";
  if (status === "success") return "✅";

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
      return "✓";
    case "build_start":
    case "build_progress":
    case "build_complete":
      return "📦";
    case "checkpoint_created":
      return "💾";
    case "revision_created":
      return "📝";
    case "thinking":
      return "🤔";
    case "planning":
      return "📋";
    case "info":
      return "ℹ️";
    default:
      return "⋯";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
