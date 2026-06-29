// Shared test harness for component/page tests.
//
// Many components render clickable address links (AddressLink / TxidLink ->
// useRecordPreview) or Radix Tooltips (HopPathExplorer, RecordTable,
// RecordDetailPanel, report panels, etc.). Both throw when mounted
// outside their providers (RecordPreviewProvider / TooltipProvider), which
// silently unmounts the whole tree and makes tests fail in confusing ways. Many
// of these components only render the link/tooltip conditionally, so a bare
// `render(<X />)` happens to pass today but a future UI tweak that always mounts
// an AddressLink/Tooltip there would trip this latent fragility.
//
// This helper wraps the tree in the full provider stack
// (ActivityBusProvider -> TooltipProvider -> RecordPreviewProvider) so adding
// such components later cannot crash the tree. Tests should use
// `renderWithProviders(<X />)` (or the `TestProviders` wrapper directly) instead
// of inlining a bare `render(<X />)` or a partial provider wrapper.

import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";

export function TestProviders({ children }: { children: ReactNode }) {
  return (
    <ActivityBusProvider>
      <TooltipProvider>
        <RecordPreviewProvider>{children}</RecordPreviewProvider>
      </TooltipProvider>
    </ActivityBusProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
  return render(ui, { wrapper: TestProviders, ...options });
}
