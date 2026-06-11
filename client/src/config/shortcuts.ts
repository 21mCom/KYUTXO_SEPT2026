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
