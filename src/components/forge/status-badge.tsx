"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toneClasses, type ToneColor } from "./lib/format";

// ---------------------------------------------------------------------------
// Tone → color maps (kept here so the whole UI uses one consistent palette)
// ---------------------------------------------------------------------------

export const PROJECT_STATUS_TONE: Record<string, ToneColor> = {
  DRAFT: "slate",
  ARCHITECTING: "violet",
  AWAITING_ARCHITECTURE_APPROVAL: "amber",
  ARCHITECTURE_FROZEN: "cyan",
  PREFLIGHT: "blue",
  BUILDING: "orange",
  VERIFYING: "fuchsia",
  BLOCKED: "red",
  HUMAN_REVIEW_REQUIRED: "amber",
  PRODUCTION_READY: "emerald",
  DEPLOYED: "emerald",
  FAILED: "red",
};

export const TASK_STATUS_TONE: Record<string, ToneColor> = {
  PLANNED: "slate",
  QUEUED: "blue",
  RUNNING: "orange",
  REVIEWING: "amber",
  BLOCKED: "red",
  FAILED: "red",
  COMPLETED: "emerald",
};

export const AGENT_STATE_TONE: Record<string, ToneColor> = {
  IDLE: "slate",
  RUNNING: "orange",
  ERROR: "red",
  BUSY: "orange",
};

export const READINESS_TONE: Record<string, ToneColor> = {
  PASSED: "emerald",
  FAILED: "red",
  PENDING: "amber",
  SKIPPED: "slate",
  RUNNING: "orange",
};

// ---------------------------------------------------------------------------
// StatusBadge — soft, bordered, used for status pills everywhere.
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  status: string | null | undefined;
  toneMap?: Record<string, ToneColor>;
  className?: string;
  withDot?: boolean;
  label?: string;
}

export function StatusBadge({
  status,
  toneMap,
  className,
  withDot = true,
  label,
}: StatusBadgeProps) {
  const text = label ?? status ?? "—";
  const tone =
    (status && (toneMap?.[status] ?? PROJECT_STATUS_TONE[status])) || "slate";
  const cls = toneClasses(tone);

  return (
    <Badge
      variant="outline"
      className={cn("font-medium gap-1.5", cls.soft, className)}
    >
      {withDot && (
        <span
          className={cn("inline-block size-1.5 rounded-full", cls.dot)}
          aria-hidden
        />
      )}
      <span className="truncate">{text}</span>
    </Badge>
  );
}

export function ProjectStatusBadge({ status }: { status: string | null | undefined }) {
  return <StatusBadge status={status} toneMap={PROJECT_STATUS_TONE} />;
}

export function TaskStatusBadge({ status }: { status: string | null | undefined }) {
  return <StatusBadge status={status} toneMap={TASK_STATUS_TONE} />;
}

export function AgentStateBadge({ state }: { state: string | null | undefined }) {
  return <StatusBadge status={state} toneMap={AGENT_STATE_TONE} label={state || "IDLE"} />;
}

export function ReadinessStatusBadge({ status }: { status: string | null | undefined }) {
  return <StatusBadge status={status} toneMap={READINESS_TONE} />;
}

// ---------------------------------------------------------------------------
// AgentBadge — colored by AGENT_META color (violet/amber/rose/emerald/cyan/
// orange/slate/fuchsia/blue). Blue is allowed here as a per-agent accent.
// ---------------------------------------------------------------------------

import { AGENT_META, type AgentType } from "@/lib/types";

export function AgentBadge({
  agentType,
  withLabel = true,
  className,
}: {
  agentType: AgentType | string | null | undefined;
  withLabel?: boolean;
  className?: string;
}) {
  if (!agentType) return null;
  const meta = AGENT_META[agentType as AgentType];
  const tone = (meta?.color as ToneColor) || "slate";
  const cls = toneClasses(tone);
  return (
    <Badge
      variant="outline"
      className={cn("font-medium gap-1.5", cls.soft, className)}
    >
      <span className={cn("inline-block size-1.5 rounded-full", cls.dot)} aria-hidden />
      {withLabel && <span className="truncate">{meta?.label ?? agentType}</span>}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// ToneBadge — generic badge for arbitrary labels with a chosen tone.
// ---------------------------------------------------------------------------

export function ToneBadge({
  tone,
  children,
  className,
  withDot = false,
}: {
  tone: ToneColor;
  children: React.ReactNode;
  className?: string;
  withDot?: boolean;
}) {
  const cls = toneClasses(tone);
  return (
    <Badge variant="outline" className={cn("font-medium gap-1.5", cls.soft, className)}>
      {withDot && (
        <span className={cn("inline-block size-1.5 rounded-full", cls.dot)} aria-hidden />
      )}
      {children}
    </Badge>
  );
}
