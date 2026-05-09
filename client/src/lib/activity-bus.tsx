import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';

export interface ActivityTask {
  id: string;
  label: string;
  phase: string;
  current: number;
  total: number;
  startedAt: number;
  lastProgressAt: number;
}

export type ActivityEventKind = 'progress' | 'start' | 'complete' | 'error' | 'longtask' | 'info';

export interface ActivityEvent {
  id: string;
  kind: ActivityEventKind;
  label: string;
  message: string;
  ts: number;
  duration?: number;
}

export interface StorageQuota {
  usage: number;
  quota: number;
}

interface ActivityBusState {
  tasks: ActivityTask[];
  events: ActivityEvent[];
  storageQuota: StorageQuota | null;
  isStuck: boolean;
  monitorEnabled: boolean;
  monitorPanelOpen: boolean;
}

interface ActivityBusContextType extends ActivityBusState {
  publishTask: (task: Omit<ActivityTask, 'startedAt' | 'lastProgressAt'> & { startedAt?: number }) => void;
  completeTask: (id: string) => void;
  removeTask: (id: string) => void;
  pushEvent: (event: Omit<ActivityEvent, 'id' | 'ts'>) => void;
  setMonitorEnabled: (enabled: boolean) => void;
  setMonitorPanelOpen: (open: boolean) => void;
}

const MAX_EVENTS = 50;
const STUCK_THRESHOLD_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const STORAGE_CHECK_INTERVAL_MS = 60_000;
const MONITOR_ENABLED_KEY = 'activity-monitor-enabled';
const EVENTS_STORAGE_KEY = 'activity-events';
const EVENTS_PERSIST_DEBOUNCE_MS = 500;

function loadPersistedEvents(): ActivityEvent[] {
  try {
    const raw = sessionStorage.getItem(EVENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: ActivityEvent[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item.id === 'string' &&
        typeof item.kind === 'string' &&
        typeof item.label === 'string' &&
        typeof item.message === 'string' &&
        typeof item.ts === 'number'
      ) {
        valid.push(item as ActivityEvent);
        if (valid.length >= MAX_EVENTS) break;
      }
    }
    return valid;
  } catch {
    return [];
  }
}

const ActivityBusContext = createContext<ActivityBusContextType | null>(null);

let _publishTask: ActivityBusContextType['publishTask'] | null = null;
let _completeTask: ActivityBusContextType['completeTask'] | null = null;
let _pushEvent: ActivityBusContextType['pushEvent'] | null = null;

export function getActivityBus() {
  return {
    publishTask: (task: Parameters<ActivityBusContextType['publishTask']>[0]) => {
      try { _publishTask?.(task); } catch {}
    },
    completeTask: (id: string) => {
      try { _completeTask?.(id); } catch {}
    },
    pushEvent: (event: Omit<ActivityEvent, 'id' | 'ts'>) => {
      try { _pushEvent?.(event); } catch {}
    },
  };
}

let _eventCounter = 0;

function makeEventId() {
  return `evt_${Date.now()}_${++_eventCounter}`;
}

export function ActivityBusProvider({ children }: { children: ReactNode }) {
  const monitorEnabledInit = () => {
    try {
      const stored = localStorage.getItem(MONITOR_ENABLED_KEY);
      return stored === null ? true : stored !== 'false';
    } catch {
      return true;
    }
  };

  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>(loadPersistedEvents);
  const [storageQuota, setStorageQuota] = useState<StorageQuota | null>(null);
  const [isStuck, setIsStuck] = useState(false);
  const [monitorEnabled, setMonitorEnabledState] = useState(monitorEnabledInit);
  const [monitorPanelOpen, setMonitorPanelOpen] = useState(false);

  const tasksRef = useRef<ActivityTask[]>([]);
  const eventsRef = useRef<ActivityEvent[]>(events);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    eventsRef.current = events;
    if (persistTimerRef.current !== null) return;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      try {
        sessionStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(eventsRef.current));
      } catch {}
    }, EVENTS_PERSIST_DEBOUNCE_MS);
  }, [events]);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        try {
          sessionStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(eventsRef.current));
        } catch {}
      }
    };
  }, []);

  const pushEvent = useCallback((event: Omit<ActivityEvent, 'id' | 'ts'>) => {
    const full: ActivityEvent = { ...event, id: makeEventId(), ts: Date.now() };
    setEvents(prev => {
      const next = [full, ...prev];
      if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
      return next;
    });
  }, []);

  const publishTask = useCallback((task: Omit<ActivityTask, 'startedAt' | 'lastProgressAt'> & { startedAt?: number }) => {
    const now = Date.now();
    // Read current state synchronously from ref for deterministic event emission
    const existing = tasksRef.current.find(t => t.id === task.id);
    const isNew = !existing;
    const phaseChanged = existing ? existing.phase !== task.phase : false;

    setTasks(prev => {
      const found = prev.find(t => t.id === task.id);
      if (found) {
        const updated: ActivityTask = { ...found, ...task, lastProgressAt: now };
        const next = prev.map(t => t.id === task.id ? updated : t);
        tasksRef.current = next;
        return next;
      }
      const full: ActivityTask = {
        ...task,
        startedAt: task.startedAt ?? now,
        lastProgressAt: now,
      };
      const next = [...prev, full];
      tasksRef.current = next;
      return next;
    });

    let logEvent: ActivityEvent | null = null;
    if (isNew) {
      logEvent = {
        id: makeEventId(),
        kind: 'start',
        label: task.label,
        message: `Started: ${task.label}`,
        ts: now,
      };
    } else if (phaseChanged) {
      // Only log on meaningful phase transitions, not count-only changes
      logEvent = {
        id: makeEventId(),
        kind: 'progress',
        label: task.label,
        message: `${task.label}: ${task.phase}`,
        ts: now,
      };
    }
    if (logEvent) {
      const captured = logEvent;
      setEvents(prev => {
        const next = [captured, ...prev];
        if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
        return next;
      });
    }
  }, []);

  const completeTask = useCallback((id: string) => {
    const now = Date.now();
    // Read label from ref synchronously before setState
    const completedTask = tasksRef.current.find(t => t.id === id);
    const completedLabel = completedTask?.label ?? '';

    setTasks(prev => {
      const next = prev.filter(t => t.id !== id);
      tasksRef.current = next;
      return next;
    });

    if (completedLabel) {
      const completeEvent: ActivityEvent = {
        id: makeEventId(),
        kind: 'complete',
        label: completedLabel,
        message: `Completed: ${completedLabel}`,
        ts: now,
      };
      setEvents(prev => {
        const next = [completeEvent, ...prev];
        if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
        return next;
      });
    }
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks(prev => {
      const next = prev.filter(t => t.id !== id);
      tasksRef.current = next;
      return next;
    });
  }, []);

  const setMonitorEnabled = useCallback((enabled: boolean) => {
    setMonitorEnabledState(enabled);
    try {
      localStorage.setItem(MONITOR_ENABLED_KEY, String(enabled));
    } catch {}
  }, []);

  useEffect(() => {
    _publishTask = publishTask;
    _completeTask = completeTask;
    _pushEvent = pushEvent;
    return () => {
      _publishTask = null;
      _completeTask = null;
      _pushEvent = null;
    };
  }, [publishTask, completeTask, pushEvent]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const stuck = tasksRef.current.some(t => (now - t.lastProgressAt) > STUCK_THRESHOLD_MS);
      setIsStuck(stuck);
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const checkStorage = async () => {
      try {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
          const estimate = await navigator.storage.estimate();
          setStorageQuota({
            usage: estimate.usage ?? 0,
            quota: estimate.quota ?? 0,
          });
        }
      } catch {}
    };
    checkStorage();
    const timer = setInterval(checkStorage, STORAGE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!('PerformanceObserver' in window)) return;
    let observer: PerformanceObserver;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'longtask') {
            const duration = Math.round(entry.duration);
            const attribution = (entry as PerformanceEntry & { attribution?: Array<{ name?: string; containerSrc?: string }> }).attribution;
            const src = attribution?.[0]?.containerSrc || attribution?.[0]?.name || 'unknown';
            let source = 'unknown';
            if (src.includes('sync') || src.includes('transaction')) source = 'sync';
            else if (src.includes('render') || src.includes('react')) source = 'render';
            else if (src.includes('query') || src.includes('dexie') || src.includes('idb')) source = 'query';
            try {
              _pushEvent?.({
                kind: 'longtask',
                label: 'Long Task',
                message: `Main thread blocked ${duration}ms (${source})`,
                duration,
              });
            } catch {}
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {}
    return () => {
      try { observer?.disconnect(); } catch {}
    };
  }, []);

  return (
    <ActivityBusContext.Provider value={{
      tasks,
      events,
      storageQuota,
      isStuck,
      monitorEnabled,
      monitorPanelOpen,
      publishTask,
      completeTask,
      removeTask,
      pushEvent,
      setMonitorEnabled,
      setMonitorPanelOpen,
    }}>
      {children}
    </ActivityBusContext.Provider>
  );
}

export function useActivityBus() {
  const ctx = useContext(ActivityBusContext);
  if (!ctx) throw new Error('useActivityBus must be used within ActivityBusProvider');
  return ctx;
}
