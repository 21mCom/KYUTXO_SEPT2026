import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type ScrollPositionVariant = "default" | "table" | "compact";
type ScrollPositionPlacement = "top" | "bottom";

interface ScrollPositionIndicatorProps {
  virtualItems: { index: number; start: number; end: number }[];
  totalCount: number;
  scrollElement: HTMLElement | null;
  label?: string;
  fadeOutDelay?: number;
  fadeOutDuration?: number;
  className?: string;
  variant?: ScrollPositionVariant;
  position?: ScrollPositionPlacement;
}

const DEFAULT_FADE_OUT_DELAY_MS = 1500;
const DEFAULT_FADE_OUT_DURATION_MS = 300;
const INITIAL_FLASH_MS = 1000;

const variantStyles: Record<ScrollPositionVariant, { wrapper: string; pill: string }> = {
  default: {
    wrapper: "",
    pill: "bg-background/80 backdrop-blur-sm border shadow-sm px-3 py-1 text-xs",
  },
  table: {
    wrapper: "",
    pill: "bg-muted/90 backdrop-blur-sm border shadow-sm px-3 py-1 text-xs",
  },
  compact: {
    wrapper: "py-0.5",
    pill: "bg-background/80 backdrop-blur-sm border shadow-sm px-2 py-0.5 text-[11px]",
  },
};

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reducedMotion;
}

export function ScrollPositionIndicator({
  virtualItems,
  totalCount,
  scrollElement,
  label = "rows",
  fadeOutDelay = DEFAULT_FADE_OUT_DELAY_MS,
  fadeOutDuration = DEFAULT_FADE_OUT_DURATION_MS,
  className,
  variant = "default",
  position = "bottom",
}: ScrollPositionIndicatorProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!scrollElement) return;

    if (!prefersReducedMotion) {
      setVisible(true);
      timerRef.current = setTimeout(() => setVisible(false), INITIAL_FLASH_MS);
    }

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
  }, [scrollElement, fadeOutDelay, prefersReducedMotion]);

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

  const styles = variantStyles[variant];

  return (
    <div
      className={cn(
        "sticky flex justify-center pointer-events-none py-1 z-20",
        !prefersReducedMotion && "transition-opacity",
        position === "top" ? "top-0" : "bottom-0",
        styles.wrapper,
        className,
      )}
      style={{ opacity: visible ? 1 : 0, transitionDuration: `${fadeOutDuration}ms` }}
      data-testid="scroll-position-indicator"
    >
      <span className={cn("rounded-md text-muted-foreground", styles.pill)}>
        {firstIndex.toLocaleString()}&ndash;{lastIndex.toLocaleString()} of {totalCount.toLocaleString()} {label}
      </span>
    </div>
  );
}
