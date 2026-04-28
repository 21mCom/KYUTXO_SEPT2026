interface ScrollPositionIndicatorProps {
  virtualItems: { index: number; start: number; end: number }[];
  totalCount: number;
  scrollElement: HTMLElement | null;
  label?: string;
}

export function ScrollPositionIndicator({
  virtualItems,
  totalCount,
  scrollElement,
  label = "rows",
}: ScrollPositionIndicatorProps) {
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
      className="sticky bottom-0 flex justify-center pointer-events-none py-1 z-10"
      data-testid="scroll-position-indicator"
    >
      <span className="bg-background/80 backdrop-blur-sm border rounded-md px-3 py-1 text-xs text-muted-foreground shadow-sm">
        {firstIndex.toLocaleString()}&ndash;{lastIndex.toLocaleString()} of {totalCount.toLocaleString()} {label}
      </span>
    </div>
  );
}
