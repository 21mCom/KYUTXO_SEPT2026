import { useState, useEffect } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): [T, boolean] {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  const isPending = value !== debounced;

  return [debounced, isPending];
}
