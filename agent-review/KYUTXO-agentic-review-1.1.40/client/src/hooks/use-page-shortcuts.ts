import { useEffect } from "react";
import {
  registerPageShortcuts,
  type KeyboardShortcut,
} from "@/config/shortcuts";

/**
 * Register the current page's context-specific keyboard shortcuts while it is
 * mounted, so they appear in the "This page" section of the shortcuts help
 * dialog. The registration is cleaned up automatically on unmount.
 *
 * @param page Human-readable label for the active page (e.g. "Provenance").
 * @param shortcuts The page's local shortcuts.
 */
export function usePageShortcuts(
  page: string,
  shortcuts: KeyboardShortcut[],
): void {
  const key = JSON.stringify({ page, shortcuts });
  useEffect(() => {
    return registerPageShortcuts({ page, shortcuts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
