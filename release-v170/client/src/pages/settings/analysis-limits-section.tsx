import { useState } from "react";
import { Shield, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  useSettings,
  updateCancelConfirmThreshold,
  updatePrivacyHistoryLimit,
  updateFundTrailTxLimit,
  updateSourceOfFundsTxLimit,
  updateIntermediaryAddressCap,
} from "@/hooks/use-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { getPrivacyAuditHistoryCount } from "@/lib/data/privacy-history-crud";

// Lowering the Privacy Audit History limit deletes the oldest runs. When more
// than this many runs would be removed, confirm with the user first so a misclick
// doesn't silently wipe a lot of history.
const PRIVACY_HISTORY_TRIM_CONFIRM_THRESHOLD = 20;

export function AnalysisLimitsSection() {
  const {
    cancelConfirmThreshold,
    privacyHistoryLimit,
    fundTrailTxLimit,
    sourceOfFundsTxLimit,
    intermediaryAddressCap,
    isLoading: settingsLoading,
  } = useSettings();
  const { toast } = useToast();

  const [pendingHistoryTrim, setPendingHistoryTrim] = useState<
    { limit: number; removeCount: number } | null
  >(null);

  // Commit a new Privacy Audit History retention limit, trimming older runs and
  // surfacing how many were removed.
  const applyPrivacyHistoryLimit = async (limit: number) => {
    try {
      const removed = await updatePrivacyHistoryLimit(limit);
      if (removed > 0) {
        toast({
          title: `Removed ${removed.toLocaleString()} older ${removed === 1 ? "run" : "runs"}`,
          description: "Older Privacy Audit runs beyond the new limit were deleted.",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to update retention limit",
        variant: "destructive",
      });
    }
  };

  // Picking a new limit: if a large number of runs would be deleted, confirm
  // first so a misclick doesn't silently wipe a lot of history. Small/no-op
  // trims apply immediately.
  const handlePrivacyHistoryLimitChange = async (limit: number) => {
    try {
      const total = await getPrivacyAuditHistoryCount();
      const removeCount = total - limit;
      if (removeCount > PRIVACY_HISTORY_TRIM_CONFIRM_THRESHOLD) {
        setPendingHistoryTrim({ limit, removeCount });
        return;
      }
    } catch {
      // If we can't preview the count, fall through to applying directly; the
      // trim itself still reports what it removed.
    }
    await applyPrivacyHistoryLimit(limit);
  };

  const confirmPrivacyHistoryTrim = async () => {
    if (!pendingHistoryTrim) return;
    const { limit } = pendingHistoryTrim;
    setPendingHistoryTrim(null);
    await applyPrivacyHistoryLimit(limit);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Lineage Build
          </CardTitle>
          <CardDescription>
            Configure how the Continuity Proof lineage builder behaves
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-base">Cancel Confirmation</Label>
              <p className="text-sm text-muted-foreground">
                Ask for confirmation before cancelling a build that has reached this progress level
              </p>
            </div>
            <Select
              value={String(cancelConfirmThreshold)}
              onValueChange={async (val) => {
                try {
                  await updateCancelConfirmThreshold(Number(val));
                } catch {
                  toast({
                    title: "Error",
                    description: "Failed to update threshold",
                    variant: "destructive",
                  });
                }
              }}
              disabled={settingsLoading}
            >
              <SelectTrigger className="w-[160px]" data-testid="select-cancel-threshold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0" data-testid="option-threshold-0">Always confirm</SelectItem>
                <SelectItem value="25" data-testid="option-threshold-25">25%</SelectItem>
                <SelectItem value="50" data-testid="option-threshold-50">50%</SelectItem>
                <SelectItem value="75" data-testid="option-threshold-75">75% (default)</SelectItem>
                <SelectItem value="90" data-testid="option-threshold-90">90%</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Fund Trail
          </CardTitle>
          <CardDescription>
            Control how many transactions the Fund Trail loads per hop
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <Label className="text-base">Recent transactions per hop</Label>
              <p className="text-sm text-muted-foreground">
                On busy wallets only the most recent transactions are shown per hop. A higher limit traces more history but is slower.
              </p>
            </div>
            <Select
              value={String(fundTrailTxLimit)}
              onValueChange={async (val) => {
                try {
                  await updateFundTrailTxLimit(Number(val));
                } catch {
                  toast({
                    title: "Error",
                    description: "Failed to update transaction limit",
                    variant: "destructive",
                  });
                }
              }}
              disabled={settingsLoading}
            >
              <SelectTrigger className="w-[180px]" data-testid="select-fund-trail-tx-limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="500" data-testid="option-fund-trail-limit-500">500</SelectItem>
                <SelectItem value="1000" data-testid="option-fund-trail-limit-1000">1,000</SelectItem>
                <SelectItem value="2000" data-testid="option-fund-trail-limit-2000">2,000 (default)</SelectItem>
                <SelectItem value="5000" data-testid="option-fund-trail-limit-5000">5,000</SelectItem>
                <SelectItem value="10000" data-testid="option-fund-trail-limit-10000">10,000</SelectItem>
                <SelectItem value="25000" data-testid="option-fund-trail-limit-25000">25,000</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <Label className="text-base">Intermediary addresses in exports</Label>
              <p className="text-sm text-muted-foreground">
                How many intermediary addresses a CSV or PDF export lists for each chain before summarizing the rest as "(+N more)". A higher cap is more complete but less scannable.
              </p>
            </div>
            <Select
              value={String(intermediaryAddressCap)}
              onValueChange={async (val) => {
                try {
                  await updateIntermediaryAddressCap(Number(val));
                } catch {
                  toast({
                    title: "Error",
                    description: "Failed to update intermediary-address cap",
                    variant: "destructive",
                  });
                }
              }}
              disabled={settingsLoading}
            >
              <SelectTrigger className="w-[180px]" data-testid="select-intermediary-address-cap">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5" data-testid="option-intermediary-cap-5">5</SelectItem>
                <SelectItem value="10" data-testid="option-intermediary-cap-10">10 (default)</SelectItem>
                <SelectItem value="25" data-testid="option-intermediary-cap-25">25</SelectItem>
                <SelectItem value="50" data-testid="option-intermediary-cap-50">50</SelectItem>
                <SelectItem value="100" data-testid="option-intermediary-cap-100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Source of Funds Report
          </CardTitle>
          <CardDescription>
            Control how many funding transactions the Source of Funds Report processes per run
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <Label className="text-base">Transactions per report</Label>
              <p className="text-sm text-muted-foreground">
                On busy addresses only the most important funding transactions are processed. A higher limit is more complete but slower.
              </p>
            </div>
            <Select
              value={String(sourceOfFundsTxLimit)}
              onValueChange={async (val) => {
                try {
                  await updateSourceOfFundsTxLimit(Number(val));
                } catch {
                  toast({
                    title: "Error",
                    description: "Failed to update transaction limit",
                    variant: "destructive",
                  });
                }
              }}
              disabled={settingsLoading}
            >
              <SelectTrigger className="w-[180px]" data-testid="select-source-of-funds-tx-limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="500" data-testid="option-sof-limit-500">500</SelectItem>
                <SelectItem value="1000" data-testid="option-sof-limit-1000">1,000</SelectItem>
                <SelectItem value="2000" data-testid="option-sof-limit-2000">2,000 (default)</SelectItem>
                <SelectItem value="5000" data-testid="option-sof-limit-5000">5,000</SelectItem>
                <SelectItem value="10000" data-testid="option-sof-limit-10000">10,000</SelectItem>
                <SelectItem value="25000" data-testid="option-sof-limit-25000">25,000</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Privacy Audit History
          </CardTitle>
          <CardDescription>
            Control how many past Privacy Audit runs are kept for trend tracking
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <Label className="text-base">Runs to keep</Label>
              <p className="text-sm text-muted-foreground">
                Older runs beyond this limit are removed automatically (oldest first)
              </p>
            </div>
            <Select
              value={String(privacyHistoryLimit)}
              onValueChange={(val) => {
                void handlePrivacyHistoryLimitChange(Number(val));
              }}
              disabled={settingsLoading}
            >
              <SelectTrigger className="w-[160px]" data-testid="select-privacy-history-limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10" data-testid="option-history-limit-10">10 runs</SelectItem>
                <SelectItem value="30" data-testid="option-history-limit-30">30 runs (default)</SelectItem>
                <SelectItem value="50" data-testid="option-history-limit-50">50 runs</SelectItem>
                <SelectItem value="100" data-testid="option-history-limit-100">100 runs</SelectItem>
                <SelectItem value="250" data-testid="option-history-limit-250">250 runs</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Confirm before lowering the Privacy Audit History limit deletes a large batch of older runs */}
      <AlertDialog
        open={pendingHistoryTrim !== null}
        onOpenChange={(open) => !open && setPendingHistoryTrim(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Remove older audit runs?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingHistoryTrim
                ? `This will permanently remove ${pendingHistoryTrim.removeCount.toLocaleString()} older Privacy Audit ${pendingHistoryTrim.removeCount === 1 ? "run" : "runs"}, keeping only the most recent ${pendingHistoryTrim.limit.toLocaleString()}. This cannot be undone. Continue?`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-history-trim">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmPrivacyHistoryTrim()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-history-trim"
            >
              Remove runs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
