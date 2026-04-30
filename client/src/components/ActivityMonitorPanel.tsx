import { useState, useEffect } from 'react';
import { useActivityBus, type ActivityEvent, type ActivityTask } from '@/lib/activity-bus';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Activity, AlertTriangle, CheckCircle, Clock, Database, ChevronDown, ChevronUp } from 'lucide-react';

function useLiveTick(intervalMs: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function TaskRow({ task }: { task: ActivityTask }) {
  const now = Date.now();
  const elapsed = now - task.startedAt;
  const sinceProgress = now - task.lastProgressAt;
  const stuck = sinceProgress > 15_000;
  const pct = task.total > 0 ? Math.round((task.current / task.total) * 100) : 0;

  return (
    <div className="space-y-1 py-1.5 border-b border-border/50 last:border-b-0" data-testid={`task-row-${task.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground truncate flex-1">{task.label}</span>
        <span className={`text-xs shrink-0 ${stuck ? 'text-amber-500' : 'text-muted-foreground'}`}>
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground truncate">{task.phase}</div>
      {task.total > 0 && (
        <div className="space-y-0.5">
          <Progress value={pct} className="h-1" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{task.current.toLocaleString()} / {task.total.toLocaleString()}</span>
            <span className={stuck ? 'text-amber-500 flex items-center gap-1' : 'text-muted-foreground'}>
              {stuck && <AlertTriangle className="h-3 w-3" />}
              {stuck
                ? `no progress ${formatElapsed(sinceProgress)}`
                : `last update ${formatElapsed(sinceProgress)} ago`}
            </span>
          </div>
        </div>
      )}
      {task.total === 0 && (
        <div className="text-xs text-muted-foreground">
          {stuck
            ? <span className="text-amber-500 flex items-center gap-1"><AlertTriangle className="h-3 w-3 inline mr-0.5" />no progress {formatElapsed(sinceProgress)}</span>
            : `last update ${formatElapsed(sinceProgress)} ago`}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const icon = event.kind === 'error'
    ? <AlertTriangle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
    : event.kind === 'complete'
    ? <CheckCircle className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
    : event.kind === 'longtask'
    ? <Clock className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
    : <Activity className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />;

  const timeStr = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="flex items-start gap-1.5 py-1 border-b border-border/30 last:border-b-0" data-testid={`event-row-${event.id}`}>
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground leading-tight truncate">{event.message}</div>
        <div className="text-xs text-muted-foreground">{timeStr}</div>
      </div>
    </div>
  );
}

export function ActivityMonitorPanel() {
  const { tasks, events, storageQuota, isStuck, monitorEnabled, monitorPanelOpen, setMonitorPanelOpen } = useActivityBus();
  useLiveTick(monitorPanelOpen && tasks.length > 0 ? 1500 : 60_000);

  if (!monitorEnabled) return null;

  const hasActiveTasks = tasks.length > 0;
  const storagePct = storageQuota && storageQuota.quota > 0
    ? Math.round((storageQuota.usage / storageQuota.quota) * 100)
    : 0;
  const storageWarn = storagePct > 80;

  const summaryText = hasActiveTasks
    ? tasks.map(t => {
        const label = t.label.length > 20 ? t.label.slice(0, 20) + '…' : t.label;
        return t.total > 0
          ? `${label} · ${t.current.toLocaleString()} / ${t.total.toLocaleString()}`
          : label;
      }).join(' | ')
    : 'Idle';

  return (
    <div className="border-t border-border/50 mt-2 pt-2" data-testid="activity-monitor-panel">
      <button
        onClick={() => setMonitorPanelOpen(!monitorPanelOpen)}
        className="flex items-center justify-between w-full text-xs text-muted-foreground hover-elevate rounded-md px-1 py-1"
        data-testid="button-activity-monitor-toggle"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Activity className={`h-3 w-3 shrink-0 ${hasActiveTasks ? (isStuck ? 'text-amber-500' : 'text-green-500') : 'text-muted-foreground'}`} />
          <span className="truncate">{summaryText}</span>
        </div>
        {storageWarn && <Database className="h-3 w-3 text-amber-500 mx-1 shrink-0" />}
        {monitorPanelOpen ? <ChevronUp className="h-3 w-3 shrink-0 ml-1" /> : <ChevronDown className="h-3 w-3 shrink-0 ml-1" />}
      </button>

      {monitorPanelOpen && (
        <div className="mt-2 space-y-3" data-testid="activity-monitor-expanded">
          {hasActiveTasks && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
                Active ({tasks.length})
              </div>
              <div className="px-1">
                {tasks.map(task => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            </div>
          )}

          {storageQuota && storageQuota.quota > 0 && (
            <div className="px-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span className="flex items-center gap-1">
                  <Database className="h-3 w-3" />
                  Storage
                </span>
                <span className={storageWarn ? 'text-amber-500' : ''}>
                  {formatBytes(storageQuota.usage)} / {formatBytes(storageQuota.quota)} ({storagePct}%)
                </span>
              </div>
              <Progress
                value={storagePct}
                className={`h-1 ${storageWarn ? '[&>div]:bg-amber-500' : ''}`}
              />
              {storageWarn && (
                <div className="text-xs text-amber-500 mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Storage above 80%
                </div>
              )}
            </div>
          )}

          {events.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1 px-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent Activity</span>
                <span className="text-xs text-muted-foreground/60">newest first</span>
              </div>
              <ScrollArea className="h-40 px-1">
                {events.map(event => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ScrollArea>
            </div>
          )}

          {!hasActiveTasks && events.length === 0 && (
            <div className="text-xs text-muted-foreground px-1 py-2 text-center">
              No recent activity
            </div>
          )}
        </div>
      )}
    </div>
  );
}
