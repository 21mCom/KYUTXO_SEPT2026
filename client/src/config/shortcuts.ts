/**
 * Central registry of every global keyboard shortcut in the app.
 *
 * This is the single source of truth that powers the keyboard shortcuts help
 * dialog (opened with "?"). Whenever a new global shortcut is added anywhere in
 * the app, add a matching entry here so it stays documented and discoverable.
 *
 * `keys` is an ordered list of key tokens that make up the chord. They are
 * rendered as individual <kbd> elements in the help dialog. Use the platform
 * placeholder "Cmd/Ctrl" for shortcuts that respond to either the meta key
 * (macOS) or the control key (Windows/Linux).
 */
export interface KeyboardShortcut {
  /** Ordered key tokens for the chord, e.g. ["Cmd/Ctrl", "B"]. */
  keys: string[];
  /** Short human-readable description of what the shortcut does. */
  action: string;
}

export interface ShortcutGroup {
  /** Section heading shown in the help dialog. */
  category: string;
  shortcuts: KeyboardShortcut[];
}

export const KEYBOARD_SHORTCUTS: ShortcutGroup[] = [
  {
    category: "General",
    shortcuts: [
      { keys: ["?"], action: "Show this keyboard shortcuts reference" },
      { keys: ["Cmd/Ctrl", "K"], action: "Search pages, records, addresses, and transactions" },
    ],
  },
  {
    category: "Navigation",
    shortcuts: [
      { keys: ["Cmd/Ctrl", "B"], action: "Toggle the sidebar" },
    ],
  },
  {
    category: "Monitoring",
    shortcuts: [
      { keys: ["Alt", "A"], action: "Toggle the activity monitor popover" },
    ],
  },
];

/**
 * Page-scoped keyboard shortcuts store.
 *
 * Most shortcuts in {@link KEYBOARD_SHORTCUTS} are global and always available.
 * Individual pages, however, often have their own context-specific shortcuts
 * (e.g. "Enter to search" inside an input). Those pages can register their
 * shortcuts here while mounted so they appear in a "This page" section of the
 * help dialog, then clean up automatically on unmount.
 *
 * Because routes render one page at a time, the store holds the shortcuts for
 * whichever page (or component) most recently registered. Use
 * {@link useRegisterPageShortcuts} from within a page/component and the dialog
 * will subscribe via {@link subscribePageShortcuts}.
 */
export interface PageShortcuts {
  /** Label for the active page, shown alongside the "This page" heading. */
  page: string;
  shortcuts: KeyboardShortcut[];
}

type Listener = () => void;

let currentPageShortcuts: PageShortcuts | null = null;
const listeners = new Set<Listener>();

function emitPageShortcuts(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Register the active page's shortcuts. Returns a cleanup function that removes
 * them again (only if they are still the active set, to avoid a later page's
 * registration being clobbered by an earlier page's delayed unmount).
 */
export function registerPageShortcuts(entry: PageShortcuts): () => void {
  currentPageShortcuts = entry;
  emitPageShortcuts();
  return () => {
    if (currentPageShortcuts === entry) {
      currentPageShortcuts = null;
      emitPageShortcuts();
    }
  };
}

export function getPageShortcuts(): PageShortcuts | null {
  return currentPageShortcuts;
}

export function subscribePageShortcuts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
