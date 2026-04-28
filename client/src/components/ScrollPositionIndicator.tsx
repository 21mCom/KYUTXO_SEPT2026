import { useEffect, useRef, useState } from "react";

interface ScrollPositionIndicatorProps {
  virtualItems: { index: number; start: number; end: number }[];
  totalCount: number;
  scrollElement: HTMLElement | null;
  label?: string;
  fadeOutDelay?: number;
}

const DEFAULT_FADE_OUT_DELAY_MS = 1500;

export function ScrollPositionIndicator({
  virtualItems,
  totalCount,
  scrollElement,
  label = "rows",
  fadeOutDelay = DEFAULT_FADE_OUT_DELAY_MS,
}: ScrollPositionIndicatorProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!scrollElement) return;

    const onScroll = () => {
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(false), fadeOutDelay);
    };

    scrollElement.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scrollElement, fadeOutDelay]);

  if (!scrollElement || virtualItems.length === 0 || totalCount === 0) return null;

  const scrollTop = scrollElement.scrollTop;
  const viewportHeight = scrollElement.clientHeight;
  const scrollHeight = scrollElement.scrollHeight;

  if (scrollHeight <= viewportHeight) return null;

  const visibleItems = virtualItems.filter(
    (item) => item.end > scrollTop && item.start < scrollTop + viewportHeight
  );

  if (visibleItems.length === 0) return null;

  const firstIndex = visibleItems[0].index + 1;
  const lastIndex = visibleItems[visibleItems.length - 1].index + 1;

  return (
    <div
      className="sticky bottom-0 flex justify-center pointer-events-none py-1 z-10 transition-opacity duration-300"
      style={{ opacity: visible ? 1 : 0 }}
      data-testid="scroll-position-indicator"
    >
      <span className="bg-background/80 backdrop-blur-sm border rounded-md px-3 py-1 text-xs text-muted-foreground shadow-sm">
        {firstIndex.toLocaleString()}&ndash;{lastIndex.toLocaleString()} of {totalCount.toLocaleString()} {label}
      </span>
    </div>
  );
}
