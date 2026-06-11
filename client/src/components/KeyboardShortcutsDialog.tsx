import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { KEYBOARD_SHORTCUTS } from "@/config/shortcuts";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          title="Keyboard shortcuts (press ?)"
          data-testid="button-keyboard-shortcuts"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid="dialog-keyboard-shortcuts">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">?</kbd> anytime to open this reference.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {KEYBOARD_SHORTCUTS.map((group) => (
            <div key={group.category} className="space-y-2">
              <div
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                data-testid={`text-shortcut-category-${group.category.toLowerCase()}`}
              >
                {group.category}
              </div>
              <div className="space-y-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.action}
                    className="flex items-center justify-between gap-3"
                    data-testid={`row-shortcut-${shortcut.keys.join("-").toLowerCase()}`}
                  >
                    <span className="text-sm text-foreground">{shortcut.action}</span>
                    <span className="flex flex-shrink-0 items-center gap-1">
                      {shortcut.keys.map((key, index) => (
                        <kbd
                          key={`${shortcut.action}-${key}-${index}`}
                          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
