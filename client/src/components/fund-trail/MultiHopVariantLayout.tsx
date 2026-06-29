import type { FundTrailViewData, FundTrailLayout } from "./view-data";
import { HorizontalHopTimeline } from "./variants/HorizontalHopTimeline";
import { VerticalTimelineScroll } from "./variants/VerticalTimelineScroll";
import { FullScreenBreakout } from "./variants/FullScreenBreakout";
import { SankeyFlow } from "./variants/SankeyFlow";

/**
 * Renders one of the alternate multi-hop Fund Trail layouts. The "classic"
 * layout (MultiHopTrailLayout) is handled directly by FundTrail.tsx and is
 * intentionally NOT routed through here, so it stays byte-for-byte untouched.
 */
export function MultiHopVariantLayout({
  layout,
  data,
}: {
  layout: Exclude<FundTrailLayout, "classic">;
  data: FundTrailViewData;
}) {
  switch (layout) {
    case "horizontal":
      return <HorizontalHopTimeline data={data} />;
    case "vertical":
      return <VerticalTimelineScroll data={data} />;
    case "breakout":
      return <FullScreenBreakout data={data} />;
    case "sankey":
      return <SankeyFlow data={data} />;
    default:
      return null;
  }
}
