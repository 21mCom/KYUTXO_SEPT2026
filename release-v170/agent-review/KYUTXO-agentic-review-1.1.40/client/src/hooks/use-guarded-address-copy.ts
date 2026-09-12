import { useCallback, useEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useToast } from "@/hooks/use-toast";
import { resolveIdentifier, getCachedRecord } from "@/lib/metadata-hover";
import {
  getSuspectedPoisoningTags,
  poisoningWarningText,
} from "@/lib/address-poisoning";

/**
 * How long (ms) a warned address stays "armed" — i.e. a second copy click
 * within this window copies anyway. Mirrors the AddressLink guard.
 */
export const POISONING_COPY_ARM_MS = 6000;

interface GuardedCopyOptions {
  /** Copy label, defaults to "Address". */
  label?: string;
  /** Confirmation key passed through to useCopyToClipboard. */
  key?: string;
}

/**
 * Shared clipboard-copy helper for ADDRESS values that applies the same
 * two-step suspected-poisoning guard as AddressLink: if the address's vault
 * record carries a suspected-poisoning tag, the first copy click shows a
 * destructive warning toast instead of copying; a second click within
 * POISONING_COPY_ARM_MS copies anyway.
 *
 * The arm state is keyed per-address so a single hook instance can back a
 * whole list of copy buttons (arming one address never arms another).
 *
 * Non-address copy affordances (txids, PSBTs, CSV text) should keep using
 * useCopyToClipboard directly.
 */
export function useGuardedAddressCopy(resetMs?: number) {
  const { copy, isCopied, copiedKey } = useCopyToClipboard(resetMs);
  const { toast } = useToast();

  const [armedAddress, setArmedAddress] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  const copyAddress = useCallback(
    async (address: string, options: GuardedCopyOptions = {}) => {
      const { label = "Address", key } = options;

      // Resolve the vault record so the guard works even when the metadata
      // cache is cold (the user may copy without ever hovering).
      let record = getCachedRecord(address);
      if (record === undefined) {
        try {
          record = await resolveIdentifier(address);
        } catch {
          record = null;
        }
      }

      const poisonTags =
        record != null ? getSuspectedPoisoningTags(record.tags) : [];
      if (poisonTags.length > 0 && armedAddress !== address) {
        setArmedAddress(address);
        if (armTimerRef.current) clearTimeout(armTimerRef.current);
        armTimerRef.current = setTimeout(
          () => setArmedAddress(null),
          POISONING_COPY_ARM_MS,
        );
        toast({
          title: "Suspected address-poisoning address",
          description: `${poisoningWarningText(poisonTags)} Click copy again to copy anyway.`,
          variant: "destructive",
        });
        return false;
      }

      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      setArmedAddress(null);
      copy(address, { label, key });
      return true;
    },
    [armedAddress, copy, toast],
  );

  const isArmed = useCallback(
    (address: string) => armedAddress === address,
    [armedAddress],
  );

  return { copy, copyAddress, isCopied, copiedKey, isArmed, armedAddress };
}
