import { useState, useEffect, useRef } from "react";
import { Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ActivityMonitorBody } from "@/components/ActivityMonitorPanel";
import { useActivityBus } from "@/lib/activity-bus";

export function ActivityPulseDot() {
  const { tasks, isStuck, monitorEnabled } = useActivityBus();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const prevActiveRef = useRef(tasks.length > 0);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    const isActive = tasks.length > 0;
    if (wasActive && !isActive && open && !pinned) {
      setOpen(false);
    }
    prevActiveRef.current = isActive;
  }, [tasks.length, open, pinned]);

  useEffect(() => {
    if (!monitorEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.key === 'a' || event.key === 'A')
      ) {
        event.preventDefault();
        setOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [monitorEnabled]);

  if (!monitorEnabled) return null;
  const active = tasks.length > 0;
  const dotClass = !active
    ? 'bg-muted-foreground/40'
    : isStuck
    ? 'bg-amber-500'
    : 'bg-green-500 animate-pulse';
  const title = !active
    ? 'Activity monitor — idle (click or press Alt+A to open)'
    : isStuck
    ? 'Operation appears stuck — click or press Alt+A to open monitor'
    : `${tasks.length} operation${tasks.length > 1 ? 's' : ''} in progress — click or press Alt+A to open monitor`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`absolute top-2 left-8 h-2 w-2 rounded-full cursor-pointer ${dotClass} ${open ? 'ring-1 ring-offset-1 ring-foreground/30' : ''}`}
          title={title}
          data-testid="activity-pulse-dot"
          aria-label={title}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-80 p-3"
        data-testid="popover-activity-monitor"
      >
        <div className="flex items-center justify-between gap-2 mb-2 px-1">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Activity Monitor
          </span>
          <Button
            size="icon"
            variant="ghost"
            className={`toggle-elevate ${pinned ? 'toggle-elevated' : ''}`}
            onClick={() => setPinned(p => !p)}
            title={pinned ? 'Unpin — popover will close when tasks finish' : 'Pin — keep popover open after tasks finish'}
            aria-label={pinned ? 'Unpin activity monitor' : 'Pin activity monitor'}
            aria-pressed={pinned}
            data-testid="button-pin-activity-monitor"
          >
            {pinned ? <Pin className="h-4 w-4 text-foreground" /> : <PinOff className="h-4 w-4 text-muted-foreground" />}
          </Button>
        </div>
        <ActivityMonitorBody />
      </PopoverContent>
    </Popover>
  );
}
