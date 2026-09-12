import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  startEngineBootstrapOnce,
  subscribeEngineMaintenance,
  getEngineMaintenanceState,
  type EngineMaintenanceState,
} from "@/lib/engine/engine-maintenance";

/**
 * Kicks off the launch engine bootstrap exactly once, after the authenticated app
 * has mounted (i.e. after auth + startup migrations). Renders nothing. A no-op in
 * the browser preview, where there is no engine to maintain.
 */
export function EngineBootstrapper() {
  useEffect(() => {
    startEngineBootstrapOnce();
  }, []);
  return null;
}

/**
 * Small header status shown only while a background seed/refresh of the read-engine
 * is running ("Preparing fast mode…"). Hidden otherwise (idle / checking / ready /
 * error), so the steady state and the browser preview show nothing.
 */
export function EnginePreparingIndicator() {
  const [state, setState] = useState<EngineMaintenanceState>(getEngineMaintenanceState);

  useEffect(() => subscribeEngineMaintenance(setState), []);

  const active = state.phase === "seeding" || state.phase === "refreshing";
  if (!active) return null;

  const pct =
    state.progress && state.progress.overallTotal > 0
      ? Math.round((state.progress.overallProcessed / state.progress.overallTotal) * 100)
      : null;
  const label = state.phase === "refreshing" ? "Refreshing fast mode" : "Preparing fast mode";
  const detail = pct !== null ? `${label} ${pct}%` : `${label}…`;

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      title="Building the local fast-search index in the background. The app stays fully usable."
      data-testid="engine-preparing-indicator"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span className="hidden sm:inline" data-testid="text-engine-preparing">{detail}</span>
    </div>
  );
}
