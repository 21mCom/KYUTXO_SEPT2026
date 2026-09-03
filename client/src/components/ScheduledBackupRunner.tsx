import { useEffect, useRef, useState } from "react";
import { getActivityBus } from "@/lib/activity-bus";
import { runDueScheduledBackup } from "@/lib/backup/scheduled";
import { toast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

let runPromise: Promise<unknown> | null = null;

/**
 * Mounted only while the vault is unlocked. It performs one due check per
 * authenticated mount; there is no daemon and no timer running while locked.
 */
export function ScheduledBackupRunner() {
  const [prompt, setPrompt] = useState<"confirm" | "password" | null>(null);
  const [password, setPassword] = useState("");
  const resolveConfirmRef = useRef<((value: boolean) => void) | null>(null);
  const resolvePasswordRef = useRef<((value: string | null) => void) | null>(null);

  useEffect(() => {
    if (runPromise) return;
    let cancelled = false;
    const controller = new AbortController();
    runPromise = runDueScheduledBackup({
      signal: controller.signal,
      requestConfirmation: () => new Promise<boolean>((resolve) => {
        resolveConfirmRef.current = resolve;
        setPrompt("confirm");
      }),
      requestPassword: () => new Promise<string | null>((resolve) => {
        resolvePasswordRef.current = resolve;
        setPassword("");
        setPrompt("password");
      }),
      onProgress: (phase) => {
        if (cancelled) return;
        try {
          getActivityBus().publishTask({ id: "scheduled-backup", label: "Scheduled Backup", phase, current: 0, total: 1 });
        } catch {}
      },
    }).then((result) => {
      if (cancelled || result.skipped) return;
      if (result.verified > 0) {
        try { getActivityBus().completeTask("scheduled-backup"); } catch {}
        toast({
          title: "Scheduled backup verified",
          description: `${result.verified} local backup ${result.verified === 1 ? "copy is" : "copies are"} ready.`,
        });
      }
      if (result.failures.length > 0) {
        toast({
          variant: "destructive",
          title: "Scheduled backup needs attention",
          description: result.failures.join(" "),
          duration: 12000,
        });
      }
    }).catch((error) => {
      if (!cancelled) {
        toast({
          variant: "destructive",
          title: "Scheduled backup failed",
          description: error instanceof Error ? error.message : String(error),
          duration: 12000,
        });
      }
    }).finally(() => {
      runPromise = null;
    });
    return () => {
      cancelled = true;
      controller.abort();
      resolveConfirmRef.current?.(false);
      resolvePasswordRef.current?.(null);
      resolveConfirmRef.current = null;
      resolvePasswordRef.current = null;
    };
  }, []);

  const cancelPrompt = () => {
    if (prompt === "confirm") resolveConfirmRef.current?.(false);
    if (prompt === "password") resolvePasswordRef.current?.(null);
    resolveConfirmRef.current = null;
    resolvePasswordRef.current = null;
    setPassword("");
    setPrompt(null);
  };

  const acceptPrompt = () => {
    if (prompt === "confirm") resolveConfirmRef.current?.(true);
    if (prompt === "password") resolvePasswordRef.current?.(password || null);
    resolveConfirmRef.current = null;
    resolvePasswordRef.current = null;
    setPassword("");
    setPrompt(null);
  };

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) cancelPrompt(); }}>
      <DialogContent data-testid="scheduled-backup-prompt">
        <DialogHeader>
          <DialogTitle>{prompt === "confirm" ? "Scheduled backup is due" : "Enter backup password"}</DialogTitle>
          <DialogDescription>
            {prompt === "confirm"
              ? "KYUTXO can create and verify the overdue local backup in the background now."
              : "This password is used only for this run. It is never stored."}
          </DialogDescription>
        </DialogHeader>
        {prompt === "password" && (
          <div className="space-y-2">
            <Label htmlFor="scheduled-backup-password">Backup password</Label>
            <Input
              id="scheduled-backup-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && password) acceptPrompt();
              }}
              autoFocus
              data-testid="input-scheduled-backup-password"
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={cancelPrompt}>Not now</Button>
          <Button onClick={acceptPrompt} disabled={prompt === "password" && password.length < 8} data-testid="button-confirm-scheduled-backup">
            {prompt === "confirm" ? "Create backup" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}