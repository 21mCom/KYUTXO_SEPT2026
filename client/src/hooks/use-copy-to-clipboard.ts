import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface CopyOptions {
  /**
   * Human-readable label for what is being copied (e.g. "Transaction ID",
   * "Address"). Drives both the success toast (`${label} copied`) and the
   * destructive failure toast.
   */
  label: string;
  /**
   * Optional key used to track which value is currently in the confirmed
   * (green check) state when a single hook instance backs several copy
   * buttons. Defaults to the copied text itself.
   */
  key?: string;
}

/**
 * Shared clipboard-copy helper that centralizes the "write to clipboard ->
 * flash a 2s confirmation -> success / destructive toast" behavior so every
 * copy button gives users identical feedback.
 */
export function useCopyToClipboard(resetMs: number = 2000) {
  const { toast } = useToast();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    (text: string, { label, key }: CopyOptions) => {
      const confirmKey = key ?? text;

      const notifyFailure = () => {
        toast({
          title: "Copy failed",
          description: `Could not copy the ${label.toLowerCase()} to your clipboard.`,
          variant: "destructive",
        });
      };

      const onSuccess = () => {
        setCopiedKey(confirmKey);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopiedKey(null), resetMs);
        toast({ description: `${label} copied` });
      };

      try {
        const result = navigator.clipboard?.writeText(text);
        if (!result) {
          notifyFailure();
          return;
        }
        result.then(onSuccess).catch(notifyFailure);
      } catch {
        notifyFailure();
      }
    },
    [toast, resetMs]
  );

  const isCopied = useCallback((key: string) => copiedKey === key, [copiedKey]);

  return { copy, copiedKey, isCopied };
}
