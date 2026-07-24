import { useState } from "react";
import { Loader2, Trash2, AlertTriangle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { clearAllRecords } from "@/lib/data/record-crud";
import { clearTransactions, clearParticipants } from "@/lib/data/transaction-crud";
import { clearAttachments } from "@/lib/data/attachments-crud";
import { clearRecordOrigins } from "@/lib/data/record-origins-crud";
import { clearCustomFields } from "@/lib/data/custom-fields-crud";
import { clearAddressSyncState } from "@/lib/data/address-sync-crud";
import { clearPriceData } from "@/lib/data/price-data-crud";
import { updateSettings } from "@/lib/data/settings-crud";
import { db } from "@/lib/database";
import { base64ToBuffer, verifyPassword } from "@/lib/crypto";
import { getVaultSettings } from "@/lib/vault";

const DELETE_CONFIRMATION_PHRASE = "DELETE ALL DATA";

// The Clear Database flow: password + typed-phrase confirmation, then a full
// wipe of records, blockchain data, vocabularies, and attachments. Split out
// of data-management-section.tsx so each flow stays reviewable.
export function ClearDatabaseFlow() {
  const { toast } = useToast();

  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState("");
  const [clearPhrase, setClearPhrase] = useState("");
  const [isClearing, setIsClearing] = useState(false);

  const handleClearDatabase = async () => {
    if (clearPhrase !== DELETE_CONFIRMATION_PHRASE) {
      toast({
        variant: "destructive",
        title: "Incorrect Phrase",
        description: `Please type "${DELETE_CONFIRMATION_PHRASE}" exactly to confirm.`,
      });
      return;
    }

    setIsClearing(true);
    try {
      // Verify password
      const settings = await getVaultSettings();
      if (!settings) {
        throw new Error("Vault not initialized");
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(clearPassword, salt, settings.passwordHash);

      if (!isValid) {
        toast({
          variant: "destructive",
          title: "Invalid Password",
          description: "The password you entered is incorrect.",
        });
        setIsClearing(false);
        return;
      }

      await clearAllRecords({ skipNotification: true });
      await db.tags.clear();
      await db.categories.clear();
      await clearAttachments({ skipNotification: true });
      await clearRecordOrigins({ skipNotification: true });
      await clearCustomFields({ skipNotification: true });
      
      // Clear blockchain sync data
      await clearTransactions({ skipNotification: true });
      await clearParticipants({ skipNotification: true });
      await clearAddressSyncState({ skipNotification: true });
      
      // Clear vocabulary tables
      await db.owners.clear();
      await db.walletNames.clear();
      await db.seedNames.clear();
      await db.walletSoftware.clear();
      
      // Clear price data
      await clearPriceData({ skipNotification: true });

      // Reset settings to defaults (but keep them)
      await updateSettings('default', {
        fieldVisibility: {
          seedName: true,
          walletSoftware: true,
          privateKeyStatus: false,
          owner: true,
          walletName: true,
          source: true,
        },
        tableColumns: {
          tags: true,
          categories: false,
          walletSoftware: false,
          seedName: false,
          privateKeyStatus: false,
          hasAttachments: true,
          owner: false,
          walletName: false,
          firstSeen: false,
          balance: false,
          lastTxDate: false,
          txCount: false,
          source: false,
        },
        customFieldColumns: {},
        cancelConfirmThreshold: 75,
        privacyHistoryLimit: 30,
      });

      setClearDialogOpen(false);
      setClearPassword("");
      setClearPhrase("");
      
      toast({
        title: "Database Cleared",
        description: "All records, blockchain data, vocabularies, and attachments have been deleted.",
      });

      // Reload the page to reset all state
      window.location.reload();
    } catch (error) {
      console.error("Failed to clear database:", error);
      toast({
        variant: "destructive",
        title: "Clear Failed",
        description: error instanceof Error ? error.message : "Failed to clear database",
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base text-destructive">Clear Database</Label>
                <p className="text-sm text-muted-foreground">
                  Permanently delete all records, tags, and categories
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={() => setClearDialogOpen(true)}
                data-testid="button-open-clear"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </div>

      {/* Clear Database Dialog */}
      <Dialog open={clearDialogOpen} onOpenChange={(open) => {
        if (!open && !isClearing) {
          setClearDialogOpen(false);
          setClearPassword("");
          setClearPhrase("");
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Clear All Data
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-destructive/10 rounded-lg border border-destructive/20">
              <p className="text-sm text-destructive font-medium">
                Warning: This action cannot be undone!
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                All records, tags, categories, attachments, and custom fields will be permanently deleted.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="clear-password">Enter your vault password</Label>
              <Input
                id="clear-password"
                type="password"
                value={clearPassword}
                onChange={(e) => setClearPassword(e.target.value)}
                placeholder="Your vault password"
                disabled={isClearing}
                data-testid="input-clear-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="clear-phrase">
                Type <span className="font-mono text-destructive">{DELETE_CONFIRMATION_PHRASE}</span> to confirm
              </Label>
              <Input
                id="clear-phrase"
                type="text"
                value={clearPhrase}
                onChange={(e) => setClearPhrase(e.target.value)}
                placeholder={DELETE_CONFIRMATION_PHRASE}
                disabled={isClearing}
                data-testid="input-clear-phrase"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setClearDialogOpen(false);
              setClearPassword("");
              setClearPhrase("");
            }} disabled={isClearing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearDatabase}
              disabled={isClearing || !clearPassword || clearPhrase !== DELETE_CONFIRMATION_PHRASE}
              data-testid="button-confirm-clear"
            >
              {isClearing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear All Data
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
