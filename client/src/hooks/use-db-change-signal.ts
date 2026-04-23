import { useState, useEffect, useRef, useMemo } from 'react';
import { subscribeToDbChanges } from '@/lib/database';

export function useDbChangeSignal(tables: string[], debounceMs?: number): number {
  const changeVersionRef = useRef(0);
  const [dbChangeSignal, setDbChangeSignal] = useState(0);
  const stableTables = useMemo(() => tables, [tables.join(',')]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToDbChanges((changedTables) => {
      if (changedTables.length === 0 || changedTables.some(t => stableTables.includes(t))) {
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
      }
    });

    return () => {
      unsubscribe();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [stableTables, debounceMs]);

  return dbChangeSignal;
}
