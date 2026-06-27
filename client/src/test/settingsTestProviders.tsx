// Shared test harness for SettingsPage panel tests.
//
// Several Settings sub-panels render clickable address links (AddressLink ->
// useRecordPreview) or Radix Tooltips. Both throw when mounted outside their
// providers (RecordPreviewProvider / TooltipProvider), which silently unmounts
// the whole page tree and makes tests fail in confusing ways. A future UI tweak
// that adds an AddressLink/Tooltip to any panel would trip this latent
// fragility.
//
// This helper wraps the page in the full provider stack
// (ActivityBusProvider -> TooltipProvider -> RecordPreviewProvider) so adding
// such components later cannot crash the tree. Settings panel tests should use
// `renderWithSettingsProviders(<SettingsPage />)` (or the `SettingsTestProviders`
// wrapper directly) instead of inlining a bare `render(<SettingsPage />)`.

import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { ActivityBusProvider } from "@/lib/activity-bus";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RecordPreviewProvider } from "@/contexts/RecordPreviewContext";

export function SettingsTestProviders({ children }: { children: ReactNode }) {
  return (
    <ActivityBusProvider>
      <TooltipProvider>
        <RecordPreviewProvider>{children}</RecordPreviewProvider>
      </TooltipProvider>
    </ActivityBusProvider>
  );
}

export function renderWithSettingsProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
  return render(ui, { wrapper: SettingsTestProviders, ...options });
}
