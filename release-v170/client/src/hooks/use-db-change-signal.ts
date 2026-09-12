import { useState, useEffect, useRef, useMemo } from 'react';
import * as database from '@/lib/database';
import type { DbChangeMeta } from '@/lib/database';

export interface UseDbChangeSignalOptions {
  /**
   * Predicate that returns true if a notification should bump the signal.
   * Receives the changed tables and any metadata published by the writer.
   * If omitted, every notification matching `tables` (or a broadcast) bumps.
   */
  filter?: (changedTables: string[], meta?: DbChangeMeta) => boolean;
}

export function useDbChangeSignal(
  tables: string[],
  debounceMs?: number,
  options?: UseDbChangeSignalOptions,
): number {
  const changeVersionRef = useRef(0);
  const [dbChangeSignal, setDbChangeSignal] = useState(0);
  const stableTables = useMemo(() => tables, [tables.join(',')]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest filter in a ref so we don't have to resubscribe each render
  // when the caller passes a fresh closure (which is the common case).
  const filterRef = useRef(options?.filter);
  filterRef.current = options?.filter;

  useEffect(() => {
    // Some isolated hook tests provide a minimal database mock. Production
    // always exports this notifier; treating an absent test-only notifier as
    // an inert subscription keeps repository-backed readers usable there.
    if (!('subscribeToDbChanges' in database)) return;
    const unsubscribe = database.subscribeToDbChanges((changedTables, meta) => {
      const tableMatches =
        changedTables.length === 0 || changedTables.some(t => stableTables.includes(t));
      if (!tableMatches) return;

      const filter = filterRef.current;
      if (filter && !filter(changedTables, meta)) return;

      const bump = () => {
        changeVersionRef.current += 1;
        setDbChangeSignal(changeVersionRef.current);
      };

      if (debounceMs != null && debounceMs > 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(bump, debounceMs);
      } else {
        bump();
      }
    });

    return () => {
      unsubscribe();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [stableTables, debounceMs]);

  return dbChangeSignal;
}
