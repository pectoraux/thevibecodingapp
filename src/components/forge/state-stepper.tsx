"use client";

import * as React from "react";
import { Check, Dot } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PROJECT_STATUS_ORDER,
  ProjectStatus as ProjectStatusType,
} from "@/lib/types";
import { PROJECT_STATUS_TONE } from "./status-badge";
import { toneClasses } from "./lib/format";

// Friendly short labels for the stepper (the enum keys are verbose).
const SHORT_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  ARCHITECTING: "Architecting",
  AWAITING_ARCHITECTURE_APPROVAL: "Awaiting Approval",
  ARCHITECTURE_FROZEN: "Frozen",
  PREFLIGHT: "Preflight",
  BUILDING: "Building",
  VERIFYING: "Verifying",
  PRODUCTION_READY: "Production Ready",
  DEPLOYED: "Deployed",
  // Terminal-but-off-path statuses shown as a trailing indicator instead.
  BLOCKED: "Blocked",
  HUMAN_REVIEW_REQUIRED: "Human Review",
  FAILED: "Failed",
};

interface StateStepperProps {
  current: string;
  className?: string;
}

export function StateStepper({ current, className }: StateStepperProps) {
  const currentIndex = PROJECT_STATUS_ORDER.indexOf(
    current as ProjectStatusType
  );
  // Off-path terminal statuses (BLOCKED / FAILED / HUMAN_REVIEW_REQUIRED) get
  // rendered as a single highlighted chip rather than a position on the line.
  const offPath = currentIndex === -1;

  if (offPath) {
    const tone = PROJECT_STATUS_TONE[current] || "slate";
    const cls = toneClasses(tone);
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border p-4",
          cls.soft,
          className
        )}
      >
        <span className={cn("inline-block size-2.5 rounded-full", cls.dot)} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{SHORT_LABEL[current] ?? current}</p>
          <p className="text-xs opacity-80">
            This project is currently in a non-linear state.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <ol
        className="flex min-w-max items-center gap-1 px-1 py-2"
        aria-label="Project lifecycle"
      >
        {PROJECT_STATUS_ORDER.map((step, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          const tone = PROJECT_STATUS_TONE[step];
          const cls = toneClasses(tone);

          return (
            <React.Fragment key={step}>
              <li className="flex flex-col items-center gap-1.5 min-w-[84px]">
                <div
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                    active
                      ? cn(cls.solid, "border-transparent")
                      : done
                        ? cn(cls.soft, "border-transparent")
                        : "border-border bg-card text-muted-foreground"
                  )}
                  aria-current={active ? "step" : undefined}
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : active ? (
                    <Dot className="size-5 -my-2" />
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    "text-center text-[10px] leading-tight font-medium",
                    active ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {SHORT_LABEL[step] ?? step}
                </span>
              </li>
              {i < PROJECT_STATUS_ORDER.length - 1 && (
                <li
                  className={cn(
                    "h-px flex-1 min-w-[12px] mt-[-18px]",
                    done ? "bg-foreground/30" : "bg-border"
                  )}
                  aria-hidden
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </div>
  );
}
