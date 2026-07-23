import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { ScoreWaterfallEntry } from "@/lib/privacy-audit";

export function gradeColor(grade: string): string {
  if (grade.startsWith("A")) return "text-green-600 dark:text-green-400";
  if (grade.startsWith("B")) return "text-blue-600 dark:text-blue-400";
  if (grade.startsWith("C")) return "text-yellow-600 dark:text-yellow-400";
  if (grade.startsWith("D")) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

export function scoreBarColor(score: number): string {
  if (score >= 80) return "#22c55e";
  if (score >= 60) return "#eab308";
  if (score >= 40) return "#f97316";
  return "#ef4444";
}

export function ScoreGauge({ score, grade }: { score: number; grade: string }) {
  const color = scoreBarColor(score);
  return (
    <div className="flex flex-col items-center gap-2" data-testid="container-score-gauge">
      <div className="relative w-28 h-28 flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="w-28 h-28 -rotate-90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/30" />
          <circle
            cx="50" cy="50" r="42" fill="none"
            stroke={color} strokeWidth="10"
            strokeDasharray={`${(score / 100) * 264} 264`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-3xl font-bold ${gradeColor(grade)}`} data-testid="text-privacy-grade">{grade}</span>
          <span className="text-xs text-muted-foreground">{score}/100</span>
        </div>
      </div>
      <span className="text-xs text-muted-foreground text-center">Privacy Score</span>
    </div>
  );
}

export function WaterfallChart({ entries }: { entries: ScoreWaterfallEntry[] }) {
  if (entries.length <= 1) return null;

  const chartData = entries.map(e => ({
    name: e.count > 1 ? `${e.label} ×${e.count}` : e.label,
    delta: e.delta,
    running: e.runningScore,
    fill: e.delta < 0 ? "#ef4444" : e.delta > 0 ? "#22c55e" : "#64748b",
    label: e.label,
  }));

  return (
    <div data-testid="container-waterfall-chart">
      <h3 className="text-sm font-medium mb-2">Score Breakdown</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 60 }}>
          <XAxis
            dataKey="name"
            tick={{ fontSize: 9 }}
            angle={-45}
            textAnchor="end"
            interval={0}
          />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
          <Tooltip
            formatter={(value: number, _name: string, entry: { payload?: { label: string; delta: number; running: number } }) => {
              const payload = entry.payload;
              if (!payload) return [value];
              if (payload.delta === 0) return [`Score: ${payload.running}`, payload.label];
              return [
                `Δ ${payload.delta > 0 ? "+" : ""}${payload.delta} → ${payload.running}`,
                payload.label,
              ];
            }}
            contentStyle={{ fontSize: 11 }}
          />
          <ReferenceLine y={80} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={60} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
          <Bar dataKey="running" maxBarSize={32}>
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-muted-foreground mt-1">
        Each bar shows the running score after each finding type is applied.
      </p>
    </div>
  );
}
