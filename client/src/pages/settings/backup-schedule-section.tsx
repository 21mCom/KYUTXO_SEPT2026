import { useEffect, useRef, useState } from "react";
import { CalendarClock, FolderOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getElectronAPISafe, isElectron } from "@/lib/electron";
import { getSettings, mutateSettings } from "@/lib/data/settings-crud";
import {
  cancelActiveScheduledBackup,
  DEFAULT_BACKUP_SCHEDULE,
  mergeBackupSchedulePolicy,
  normalizeBackupSchedule,
  type ScheduledBackupRunResult,
} from "@/lib/backup/scheduled";
import type { BackupScheduleSettings } from "@/lib/db-types";
import { useToast } from "@/hooks/use-toast";

function formatDate(value?: number): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function BackupScheduleSection() {
  const { toast } = useToast();
  const [schedule, setSchedule] = useState<BackupScheduleSettings>(DEFAULT_BACKUP_SCHEDULE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const folderPickerGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void getSettings("default").then((settings) => {
      if (!cancelled) {
        setSchedule(normalizeBackupSchedule(settings?.backupSchedule));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const chooseFolder = async () => {
    const pickerGeneration = folderPickerGenerationRef.current;
    const result = await getElectronAPISafe()?.chooseBackupFolder?.();
    if (pickerGeneration !== folderPickerGenerationRef.current || saveInFlightRef.current) return;
    if (!result || result.canceled) return;
    if (!result.success || !result.token || !result.label) {
      toast({ variant: "destructive", title: "Folder unavailable", description: result.error || "Could not use that folder." });
      return;
    }
    const destination = { token: result.token, label: result.label, path: result.path };
    setSchedule((current) => ({
      ...current,
      destinations: [...current.destinations.filter((item) => item.token !== destination.token), destination].slice(0, 2),
    }));
  };

  const save = async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    folderPickerGenerationRef.current += 1;
    setSaving(true);
    try {
      const normalized = normalizeBackupSchedule(schedule);
      if (normalized.enabled && normalized.destinations.length === 0) {
        toast({ variant: "destructive", title: "Choose a destination", description: "Select at least one local backup folder before enabling the schedule." });
        return;
      }
      const removedDestinationTokens = new Set<string>();
      const updated = await mutateSettings("default", (current) => ({
        backupSchedule: (() => {
          const currentSchedule = normalizeBackupSchedule(current.backupSchedule);
          const configuredTokens = new Set(normalized.destinations.map((destination) => destination.token));
          for (const destination of currentSchedule.destinations) {
            if (!configuredTokens.has(destination.token)) removedDestinationTokens.add(destination.token);
          }
          return mergeBackupSchedulePolicy(currentSchedule, normalized);
        })(),
      }));
      for (const token of removedDestinationTokens) cancelActiveScheduledBackup(token);
      const saved = normalizeBackupSchedule(updated?.backupSchedule ?? normalized);
      setSchedule(saved);
      toast({ title: "Backup schedule saved", description: normalized.enabled ? "KYUTXO will check whether a backup is due after each unlock." : "Scheduled backups are off." });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Backup schedule not saved",
        description: error instanceof Error ? error.message : "Could not save the backup schedule.",
      });
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  if (!isElectron()) {
    return (
      <Alert data-testid="scheduled-backup-desktop-only">
        <CalendarClock className="h-4 w-4" />
        <AlertDescription>Verified scheduled backups are available in the desktop app. Browser exports remain manual.</AlertDescription>
      </Alert>
    );
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading backup schedule…</p>;

  return (
    <div className="space-y-4" data-testid="backup-schedule-section">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label className="text-base">Verified scheduled backups</Label>
          <p className="text-sm text-muted-foreground">
            After unlock, create a local backup when the last verified copy is overdue.
          </p>
        </div>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={(enabled) => setSchedule((current) => ({ ...current, enabled }))}
          disabled={saving}
          data-testid="switch-scheduled-backups"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>Destination folders (up to two)</Label>
          <Button variant="outline" size="sm" onClick={() => void chooseFolder()} disabled={saving || schedule.destinations.length >= 2} data-testid="button-add-backup-folder">
            <FolderOpen className="mr-2 h-4 w-4" />
            Choose folder
          </Button>
        </div>
        {schedule.destinations.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No folder selected.</p>
        ) : schedule.destinations.map((destination) => (
          <div key={destination.token} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <span className="min-w-0 flex-1 break-all font-mono text-xs">{destination.path || destination.label}</span>
            <Button
              variant="ghost"
              size="icon"
               aria-label={`Remove ${destination.label}`}
               onClick={() => setSchedule((current) => ({ ...current, destinations: current.destinations.filter((item) => item.token !== destination.token) }))}
               disabled={saving}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Cadence</Label>
          <Select disabled={saving} value={String(schedule.cadenceDays)} onValueChange={(value) => setSchedule((current) => ({ ...current, cadenceDays: Number(value) as BackupScheduleSettings["cadenceDays"] }))}>
            <SelectTrigger data-testid="select-backup-cadence"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Daily</SelectItem>
              <SelectItem value="7">Weekly</SelectItem>
              <SelectItem value="14">Every two weeks</SelectItem>
              <SelectItem value="30">Monthly</SelectItem>
              <SelectItem value="90">Every 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="backup-retention">Newest copies to retain</Label>
          <Input id="backup-retention" type="number" min={1} max={100} value={schedule.retentionCount} onChange={(event) => setSchedule((current) => ({ ...current, retentionCount: Number(event.target.value) }))} disabled={saving} data-testid="input-backup-retention" />
          <p className="text-xs text-muted-foreground">Monthly checkpoints are kept in addition to this number.</p>
        </div>
        <div className="space-y-2">
          <Label>Prompt behavior</Label>
          <Select disabled={saving} value={schedule.promptBehavior} onValueChange={(value) => setSchedule((current) => ({ ...current, promptBehavior: value as BackupScheduleSettings["promptBehavior"] }))}>
            <SelectTrigger data-testid="select-backup-prompt"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Ask before starting</SelectItem>
              <SelectItem value="automatic">Start automatically when due</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label>Compact backup</Label>
            <Switch checked={schedule.compact} onCheckedChange={(compact) => setSchedule((current) => ({ ...current, compact }))} disabled={saving} data-testid="switch-scheduled-compact" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label>Encrypt backup</Label>
            <Switch checked={schedule.encrypted} onCheckedChange={(encrypted) => setSchedule((current) => ({ ...current, encrypted }))} disabled={saving} data-testid="switch-scheduled-encrypted" />
          </div>
        </div>
      </div>

      {schedule.encrypted && (
        <Alert>
          <AlertDescription>
            KYUTXO asks for the backup password when a run starts. The password and derived key are never saved.
          </AlertDescription>
        </Alert>
      )}
      <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
        Last verified: {formatDate(schedule.lastVerifiedAt)}
        {schedule.lastFailureMessage && <span className="block text-destructive">Last failure: {schedule.lastFailureMessage}</span>}
      </div>
      <Button onClick={() => void save()} disabled={saving} data-testid="button-save-backup-schedule">
        {saving ? "Saving…" : "Save backup schedule"}
      </Button>
    </div>
  );
}