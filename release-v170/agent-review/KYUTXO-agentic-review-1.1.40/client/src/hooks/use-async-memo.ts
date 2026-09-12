import { useState, useEffect, useRef, DependencyList } from "react";

export function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export async function processInChunks<T, R>(
  items: T[],
  processor: (item: T) => R,
  chunkSize: number = 500
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    for (const item of chunk) {
      results.push(processor(item));
    }
    if (i + chunkSize < items.length) {
      await yieldToUI();
    }
  }
  return results;
}

class AbortedError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortedError";
  }
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError();
}

export function useAsyncMemo<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  initialValue: T
): { value: T; isComputing: boolean } {
  const [value, setValue] = useState<T>(initialValue);
  const [isComputing, setIsComputing] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    const thisId = requestId.current;
    const controller = new AbortController();

    setIsComputing(true);

    factory(controller.signal)
      .then(result => {
        if (thisId === requestId.current && !controller.signal.aborted) {
          setValue(result);
        }
      })
      .catch(() => {
      })
      .finally(() => {
        if (thisId === requestId.current) {
          setIsComputing(false);
        }
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { value, isComputing };
}
