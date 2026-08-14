"use client";

// Forge — display formatters used across the dashboard.

export function formatTime(input: string | number | Date | null | undefined): string {
  if (input == null) return "—";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(input: string | number | Date | null | undefined): string {
  if (input == null) return "—";
  const d = new Date(input).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatTime(input);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  const hr = min / 60;
  return `${hr.toFixed(1)}h`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || Number.isNaN(usd)) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function shortSha(sha: string | null | undefined, len = 7): string {
  if (!sha) return "—";
  return sha.slice(0, len);
}

// Tailwind color name → utility class fragments used by status badges.
// Keeps the mapping centralized so the palette is consistent.
export type ToneColor =
  | "slate"
  | "violet"
  | "amber"
  | "rose"
  | "emerald"
  | "cyan"
  | "orange"
  | "fuchsia"
  | "blue"
  | "red"
  | "green";

const TONE_CLASSES: Record<ToneColor, { solid: string; soft: string; dot: string; text: string }> = {
  slate: {
    solid: "bg-slate-500 text-white",
    soft: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/50 dark:text-slate-300 dark:border-slate-800",
    dot: "bg-slate-500",
    text: "text-slate-600 dark:text-slate-400",
  },
  violet: {
    solid: "bg-violet-500 text-white",
    soft: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-900",
    dot: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
  },
  amber: {
    solid: "bg-amber-500 text-white",
    soft: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  rose: {
    solid: "bg-rose-500 text-white",
    soft: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-900",
    dot: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
  },
  emerald: {
    solid: "bg-emerald-500 text-white",
    soft: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  cyan: {
    solid: "bg-cyan-500 text-white",
    soft: "bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-950/50 dark:text-cyan-300 dark:border-cyan-900",
    dot: "bg-cyan-500",
    text: "text-cyan-600 dark:text-cyan-400",
  },
  orange: {
    solid: "bg-orange-500 text-white",
    soft: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-900",
    dot: "bg-orange-500",
    text: "text-orange-600 dark:text-orange-400",
  },
  fuchsia: {
    solid: "bg-fuchsia-500 text-white",
    soft: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/50 dark:text-fuchsia-300 dark:border-fuchsia-900",
    dot: "bg-fuchsia-500",
    text: "text-fuchsia-600 dark:text-fuchsia-400",
  },
  blue: {
    solid: "bg-blue-500 text-white",
    soft: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-900",
    dot: "bg-blue-500",
    text: "text-blue-600 dark:text-blue-400",
  },
  red: {
    solid: "bg-red-500 text-white",
    soft: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
  green: {
    solid: "bg-green-500 text-white",
    soft: "bg-green-100 text-green-700 border-green-200 dark:bg-green-950/50 dark:text-green-300 dark:border-green-900",
    dot: "bg-green-500",
    text: "text-green-600 dark:text-green-400",
  },
};

export function toneClasses(tone: ToneColor) {
  return TONE_CLASSES[tone] ?? TONE_CLASSES.slate;
}
