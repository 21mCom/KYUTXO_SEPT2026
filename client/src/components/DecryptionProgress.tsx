import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Lock, Unlock } from 'lucide-react';
import type { BulkCryptoProgress } from '@/lib/encryption/bulk-crypto';

interface DecryptionProgressProps {
  progress: BulkCryptoProgress | null;
  mode: 'decrypt' | 'encrypt';
}

export function DecryptionProgress({ progress, mode }: DecryptionProgressProps) {
  const isDecrypt = mode === 'decrypt';
  const title = isDecrypt ? 'Unlocking your vault...' : 'Securing your data...';
  const Icon = isDecrypt ? Unlock : Lock;

  let overallPercent = 0;
  let statusText = isDecrypt ? 'Preparing to decrypt...' : 'Preparing to encrypt...';

  if (progress) {
    const tableProgress = progress.total > 0 ? progress.current / progress.total : 1;
    overallPercent = Math.round(
      ((progress.tableIndex + tableProgress) / progress.tableCount) * 100
    );
    statusText = `${progress.tableName}: ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`;
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 backdrop-blur-sm"
      data-testid="container-decryption-progress"
    >
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6 space-y-6">
          <div className="flex flex-col items-center gap-3">
            <div className="p-3 rounded-full bg-primary/10">
              <Icon className="h-8 w-8 text-primary" />
            </div>
            <h2 className="text-lg font-semibold" data-testid="text-progress-title">{title}</h2>
          </div>

          <div className="space-y-2">
            <Progress value={overallPercent} className="h-2" data-testid="progress-bar" />
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground" data-testid="text-progress-status">
                {statusText}
              </p>
              <span className="text-sm font-medium" data-testid="text-progress-percent">
                {overallPercent}%
              </span>
            </div>
          </div>

          {progress && progress.failed > 0 && (
            <p className="text-xs text-destructive" data-testid="text-progress-errors">
              {progress.failed} item{progress.failed > 1 ? 's' : ''} failed
            </p>
          )}

          <p className="text-xs text-muted-foreground text-center">
            Please don't close the application
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
