import { useState, useEffect, useRef, useMemo } from 'react';
import { subscribeToDbChanges } from '@/lib/database';

export function useDbChangeSignal(tables: string[]): number {
  const changeVersionRef = useRef(0);
  const [dbChangeSignal, setDbChangeSignal] = useState(0);
  const stableTables = useMemo(() => tables, [tables.join(',')]);

  useEffect(() => {
    const unsubscribe = subscribeToDbChanges((changedTables) => {
      if (changedTables.length === 0 || changedTables.some(t => stableTables.includes(t))) {
        changeVersionRef.current += 1;
        setDbChangeSignal(changeVersionRef.current);
      }
    });

    return unsubscribe;
  }, [stableTables]);

  return dbChangeSignal;
}
