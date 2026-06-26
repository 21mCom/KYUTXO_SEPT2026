import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

export interface GraphNodeActivationProps<E extends Element> {
  onClick: (event: ReactMouseEvent<E>) => void;
  onKeyDown: (event: ReactKeyboardEvent<E>) => void;
}

/**
 * Shared click + keyboard activation handlers for clickable graph nodes
 * (SVG nodes in NetworkAnalysis / BitcoinFlowVisualizer, rows in HopPathExplorer).
 *
 * A single mouse click, or pressing Enter/Space while the node is focused,
 * invokes `activate` exactly once — so a node opens its record in one step with
 * no intermediate panel. Clicks stop propagation so they don't bubble to the
 * surrounding canvas (which clears selection / pans).
 */
export function createGraphNodeActivation<E extends Element = Element>(
  activate: () => void,
): GraphNodeActivationProps<E> {
  return {
    onClick: (event) => {
      event.stopPropagation();
      activate();
    },
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }
    },
  };
}
