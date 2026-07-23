import { useState } from "react";
import { KeyRound, Paperclip, Loader2, RefreshCw, Wrench, Trash2, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { base64ToBuffer, verifyPassword, generateSalt, hashPassword, bufferToBase64 } from "@/lib/crypto";
import { getVaultSettings, vaultDb, setAttachmentPathsMigrated } from "@/lib/vault";
import {
  migrateAttachmentPaths,
  auditAttachments,
  reconcileAttachmentPaths,
  downloadFile,
  deleteFile,
  formatFileSize,
  type AttachmentAuditResult,
  type AttachmentReconcileResult,
} from "@/lib/attachments";
import { getTrashedAttachments, deleteTrashedAttachment } from "@/lib/data/trash-crud";
import { hasUnrecoveredLegacyData } from "@/lib/legacy-decrypt";
import type { TrashedAttachment } from "@/lib/database";

export function SecurityAttachmentSection() {
  const { toast } = useToast();

  const [changePasswordDialogOpen, setChangePasswordDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isMigratingAttachments, setIsMigratingAttachments] = useState(false);
  const [isAuditingAttachments, setIsAuditingAttachments] = useState(false);
  const [attachmentAudit, setAttachmentAudit] = useState<AttachmentAuditResult | null>(null);
  const [isRepairingAttachments, setIsRepairingAttachments] = useState(false);
  const [attachmentRepair, setAttachmentRepair] = useState<AttachmentReconcileResult | null>(null);
  const [trashList, setTrashList] = useState<TrashedAttachment[] | null>(null);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  const [isPurgingTrash, setIsPurgingTrash] = useState(false);
  const [showEmptyTrashDialog, setShowEmptyTrashDialog] = useState(false);

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast({
        variant: "destructive",
        title: "Missing Information",
        description: "Please fill in all password fields.",
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords Don't Match",
        description: "New password and confirmation must match.",
      });
      return;
    }

    if (newPassword.length < 8) {
      toast({
        variant: "destructive",
        title: "Password Too Short",
        description: "New password must be at least 8 characters.",
      });
      return;
    }

    setIsChangingPassword(true);

    try {
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("Vault settings not found");
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(currentPassword, salt, settings.passwordHash);

      if (!isValid) {
        toast({
          variant: "destructive",
          title: "Invalid Password",
          description: "Current password is incorrect.",
        });
        setIsChangingPassword(false);
        return;
      }

      // Guard: some records may still hold legacy encrypted payloads that were
      // locked with the CURRENT password's key. Changing the password regenerates
      // the salt/hash, so those payloads could never be unlocked again. Block the
      // change until the user runs "Restore Locked Data" first.
      const hasLocked = await hasUnrecoveredLegacyData();
      if (hasLocked) {
        toast({
          variant: "destructive",
          title: "Unlock Your Data First",
          description:
            'Some records are still locked. Run "Restore Locked Data" in Settings before changing your password, otherwise that locked data would become permanently unreadable.',
        });
        setIsChangingPassword(false);
        return;
      }

      const newSalt = generateSalt();
      const newHash = await hashPassword(newPassword, newSalt);
      const newSaltBase64 = bufferToBase64(newSalt);

      await vaultDb.vault.update('main', { salt: newSaltBase64, passwordHash: newHash });

      toast({
        title: "Password Changed",
        description: "Password updated successfully.",
      });

      setChangePasswordDialogOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      console.error("Failed to change password:", error);
      toast({
        variant: "destructive",
        title: "Password Change Failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleManualAttachmentMigration = async () => {
    setIsMigratingAttachments(true);
    try {
      await setAttachmentPathsMigrated(false);
      const result = await migrateAttachmentPaths((current, total, message) => {
        console.log(`[Migration] ${message}`);
      });
      if (result.failed === 0 && result.migrated > 0) {
        await setAttachmentPathsMigrated(true);
        toast({
          title: "Migration Complete",
          description: `Successfully migrated ${result.migrated} attachment path${result.migrated > 1 ? 's' : ''} to hashed names.`,
        });
      } else if (result.failed > 0) {
        toast({
          variant: "destructive",
          title: "Migration Partially Failed",
          description: `Migrated ${result.migrated} path${result.migrated !== 1 ? 's' : ''}, but ${result.failed} failed. Check browser console for details. Try again or check file permissions.`,
        });
      } else if (result.migrated === 0) {
        await setAttachmentPathsMigrated(true);
        toast({
          title: "No Migration Needed",
          description: "All attachment paths are already using hashed names, or no attachments exist in the database.",
        });
      }
    } catch (error) {
      console.error("Manual attachment migration failed:", error);
      toast({
        variant: "destructive",
        title: "Migration Failed",
        description: error instanceof Error ? error.message : "An error occurred during migration.",
      });
    } finally {
      setIsMigratingAttachments(false);
    }
  };

  const handleAuditAttachments = async () => {
    setIsAuditingAttachments(true);
    try {
      const result = await auditAttachments();
      setAttachmentAudit(result);
      const issues = result.missingFiles.length + result.orphanedFiles.length;
      toast({
        title: issues === 0 ? "Audit Complete — All Good" : "Audit Complete",
        description:
          issues === 0
            ? `All ${result.matched} attachment${result.matched !== 1 ? "s" : ""} on record match a file on disk.`
            : `${result.matched} matched, ${result.missingFiles.length} missing file${result.missingFiles.length !== 1 ? "s" : ""}, ${result.orphanedFiles.length} unreferenced file${result.orphanedFiles.length !== 1 ? "s" : ""}.`,
      });
    } catch (error) {
      console.error("Attachment audit failed:", error);
      toast({
        variant: "destructive",
        title: "Audit Failed",
        description: error instanceof Error ? error.message : "An error occurred during the audit.",
      });
    } finally {
      setIsAuditingAttachments(false);
    }
  };

  const handleRepairAttachmentLinks = async () => {
    setIsRepairingAttachments(true);
    try {
      const result = await reconcileAttachmentPaths((current, total, message) => {
        console.log(`[Repair] ${message}`);
      });
      setAttachmentRepair(result);
      if (result.repaired === 0 && result.unresolved === 0) {
        toast({
          title: "Nothing to repair",
          description: "All attachments already point to a file on disk.",
        });
      } else if (result.unresolved === 0) {
        toast({
          title: "Repair complete",
          description: `Reconnected ${result.repaired} attachment${result.repaired !== 1 ? "s" : ""} to ${result.repaired !== 1 ? "their" : "its"} file on disk.`,
        });
      } else {
        toast({
          variant: result.repaired > 0 ? "default" : "destructive",
          title: result.repaired > 0 ? "Repair partially complete" : "Some attachments couldn't be repaired",
          description: `Reconnected ${result.repaired}, but ${result.unresolved} file${result.unresolved !== 1 ? "s" : ""} could not be found on disk. Run "Check" for details, or restore from a backup.`,
        });
      }
    } catch (error) {
      console.error("Attachment repair failed:", error);
      toast({
        variant: "destructive",
        title: "Repair Failed",
        description: error instanceof Error ? error.message : "An error occurred during repair.",
      });
    } finally {
      setIsRepairingAttachments(false);
    }
  };

  const handleLoadTrash = async () => {
    setIsLoadingTrash(true);
    try {
      const items = await getTrashedAttachments();
      setTrashList(items);
    } catch (error) {
      console.error("Failed to load deleted attachments:", error);
      toast({
        variant: "destructive",
        title: "Could Not Load",
        description: error instanceof Error ? error.message : "Failed to load deleted attachments.",
      });
    } finally {
      setIsLoadingTrash(false);
    }
  };

  const handleDownloadTrashed = async (item: TrashedAttachment) => {
    try {
      await downloadFile(item.objectStoragePath, item.filename);
    } catch (error) {
      console.error("Failed to download deleted attachment:", error);
      toast({
        variant: "destructive",
        title: "Download Failed",
        description:
          error instanceof Error ? error.message : "The file may have already been permanently removed.",
      });
    }
  };

  const handlePurgeTrashed = async (item: TrashedAttachment) => {
    try {
      await deleteFile(item.objectStoragePath);
      await deleteTrashedAttachment(item.id!);
      setTrashList((prev) => (prev ? prev.filter((t) => t.id !== item.id) : prev));
      toast({
        title: "File Permanently Removed",
        description: `${item.filename} was deleted from disk.`,
      });
    } catch (error) {
      console.error("Failed to purge deleted attachment:", error);
      toast({
        variant: "destructive",
        title: "Could Not Remove File",
        description: error instanceof Error ? error.message : "An error occurred while removing the file.",
      });
    }
  };

  const handleEmptyTrash = async () => {
    setShowEmptyTrashDialog(false);
    setIsPurgingTrash(true);
    try {
      const items = trashList ?? (await getTrashedAttachments());
      let removed = 0;
      for (const item of items) {
        try {
          await deleteFile(item.objectStoragePath);
          await deleteTrashedAttachment(item.id!, { skipNotification: true });
          removed++;
        } catch (error) {
          console.error("Failed to purge", item.objectStoragePath, error);
        }
      }
      const remaining = await getTrashedAttachments();
      setTrashList(remaining);
      toast({
        title: "Trash Emptied",
        description: `Permanently removed ${removed.toLocaleString()} file${removed === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      console.error("Failed to empty trash:", error);
      toast({
        variant: "destructive",
        title: "Could Not Empty Trash",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsPurgingTrash(false);
    }
  };


  return (
    <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Security
            </CardTitle>
            <CardDescription>
              Manage your vault password and attachment security
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Change Password</Label>
                <p className="text-sm text-muted-foreground">
                  Update your vault password
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setChangePasswordDialogOpen(true)}
                data-testid="button-change-password"
              >
                <KeyRound className="h-4 w-4 mr-2" />
                Change
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Migrate Attachment Paths</Label>
                <p className="text-sm text-muted-foreground">
                  Hash attachment directory and file names for privacy
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleManualAttachmentMigration}
                disabled={isMigratingAttachments}
                data-testid="button-migrate-attachments"
              >
                {isMigratingAttachments ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Migrating...
                  </>
                ) : (
                  <>
                    <Paperclip className="h-4 w-4 mr-2" />
                    Migrate
                  </>
                )}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Repair Attachment Links</Label>
                <p className="text-sm text-muted-foreground">
                  Reconnect attachments whose file moved during a previous migration. Relinks records to the matching file on disk — never moves or deletes files.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleRepairAttachmentLinks}
                disabled={isRepairingAttachments}
                data-testid="button-repair-attachments"
              >
                {isRepairingAttachments ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Repairing...
                  </>
                ) : (
                  <>
                    <Wrench className="h-4 w-4 mr-2" />
                    Repair
                  </>
                )}
              </Button>
            </div>
            {attachmentRepair && (
              <div
                className="rounded-md border p-4 space-y-2 text-sm"
                data-testid="text-attachment-repair-result"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Reconnected</span>
                  <span data-testid="text-repair-repaired">{attachmentRepair.repaired}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Still missing (no matching file found)</span>
                  <span data-testid="text-repair-unresolved">{attachmentRepair.unresolved}</span>
                </div>
                {attachmentRepair.repaired === 0 && attachmentRepair.unresolved === 0 && (
                  <p className="text-muted-foreground pt-1">
                    Everything was already linked. No repairs were needed.
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Check Attachments</Label>
                <p className="text-sm text-muted-foreground">
                  Compare your records against the files on disk. Read-only — nothing is changed or deleted.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleAuditAttachments}
                disabled={isAuditingAttachments}
                data-testid="button-audit-attachments"
              >
                {isAuditingAttachments ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Checking...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Check
                  </>
                )}
              </Button>
            </div>
            {attachmentAudit && (
              <div
                className="rounded-md border p-4 space-y-2 text-sm"
                data-testid="text-attachment-audit-result"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Attachments on record</span>
                  <span data-testid="text-audit-total-rows">{attachmentAudit.totalDbRows}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Files found on disk</span>
                  <span data-testid="text-audit-total-files">{attachmentAudit.totalDiskFiles}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Matched</span>
                  <span data-testid="text-audit-matched">{attachmentAudit.matched}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Missing files (on record but not on disk)</span>
                  <span data-testid="text-audit-missing">{attachmentAudit.missingFiles.length}</span>
                </div>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-muted-foreground">Unreferenced files (on disk but not on record)</span>
                  <span data-testid="text-audit-orphaned">{attachmentAudit.orphanedFiles.length}</span>
                </div>
                {attachmentAudit.missingFiles.length === 0 && attachmentAudit.orphanedFiles.length === 0 && (
                  <p className="text-muted-foreground pt-1">
                    Everything matches. No missing or unreferenced files.
                  </p>
                )}
              </div>
            )}

            <Separator />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <Label className="text-base">Deleted Attachments (Recoverable)</Label>
                <p className="text-sm text-muted-foreground">
                  When you delete records or attachments, their files are kept here so you can get
                  them back. Download a file to recover it, or permanently remove files to free up space.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleLoadTrash}
                disabled={isLoadingTrash}
                data-testid="button-load-trash"
              >
                {isLoadingTrash ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Show
                  </>
                )}
              </Button>
            </div>
            {trashList !== null && (
              <div className="rounded-md border p-4 space-y-3 text-sm" data-testid="container-trash-list">
                {trashList.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="text-trash-empty">
                    No deleted attachments. Nothing to recover.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-muted-foreground" data-testid="text-trash-summary">
                        {trashList.length.toLocaleString()} recoverable file{trashList.length === 1 ? "" : "s"}
                        {" · "}
                        {formatFileSize(trashList.reduce((sum, t) => sum + (t.size || 0), 0))}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setShowEmptyTrashDialog(true)}
                        disabled={isPurgingTrash}
                        data-testid="button-empty-trash"
                      >
                        {isPurgingTrash ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Permanently delete all
                          </>
                        )}
                      </Button>
                    </div>
                    <div className="space-y-2 max-h-80 overflow-auto" data-testid="list-trash-items">
                      {trashList.slice(0, 300).map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-md border p-2"
                          data-testid={`trash-item-${item.id}`}
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium" data-testid={`text-trash-filename-${item.id}`}>
                              {item.filename}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {formatFileSize(item.size)}
                              {" · "}
                              {new Date(item.deletedAt).toLocaleDateString()}
                              {item.identifier ? ` · ${item.identifier}` : ""}
                            </p>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => handleDownloadTrashed(item)}
                              data-testid={`button-download-trash-${item.id}`}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => handlePurgeTrashed(item)}
                              data-testid={`button-purge-trash-${item.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {trashList.length > 300 && (
                      <p className="text-xs text-muted-foreground">
                        Showing the 300 most recent. Use "Permanently delete all" to clear everything.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            <AlertDialog open={showEmptyTrashDialog} onOpenChange={setShowEmptyTrashDialog}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Permanently delete all recoverable files?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes every deleted attachment file from disk. This cannot be
                    undone. Any file you have not downloaded will be lost.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-cancel-empty-trash">Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleEmptyTrash} data-testid="button-confirm-empty-trash">
                    Permanently delete all
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>


      <Dialog open={changePasswordDialogOpen} onOpenChange={(open) => {
        if (!open && !isChangingPassword) {
          setChangePasswordDialogOpen(false);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Change Vault Password
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current Password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter your current password"
                disabled={isChangingPassword}
                data-testid="input-current-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password (min 8 characters)"
                disabled={isChangingPassword}
                data-testid="input-new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                disabled={isChangingPassword}
                data-testid="input-confirm-password"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => {
              setChangePasswordDialogOpen(false);
              setCurrentPassword("");
              setNewPassword("");
              setConfirmPassword("");
            }} disabled={isChangingPassword}>
              Cancel
            </Button>
            <Button
              onClick={handleChangePassword}
              disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}
              data-testid="button-confirm-change-password"
            >
              {isChangingPassword ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Changing...
                </>
              ) : (
                <>
                  <KeyRound className="h-4 w-4 mr-2" />
                  Change Password
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
