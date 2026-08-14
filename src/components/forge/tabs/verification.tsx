"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  RotateCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "../lib/api";
import { cn } from "@/lib/utils";
import { formatRelative } from "../lib/format";
import { ReadinessCategory } from "@/lib/types";
import type { ReadinessCheck } from "../lib/types";
import { ReadinessStatusBadge } from "../status-badge";

const CATEGORY_LABELS: Record<string, string> = {
  BUILD: "Build",
  STATIC: "Static analysis",
  TESTS: "Tests",
  RUNTIME: "Runtime",
  INTEGRATIONS: "Integrations",
  DATA: "Data",
  AUTH: "Authentication",
  ERRORS: "Error handling",
  OBSERVABILITY: "Observability",
  SECURITY: "Security",
  CONFIG: "Configuration",
  DEPLOYMENT: "Deployment",
  REVIEW: "Final review",
};

export function VerificationTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const q = useQuery({
    queryKey: ["verification", projectId],
    queryFn: () =>
      apiGet<{
        checks: ReadinessCheck[];
        passed: boolean;
        passedCount: number;
        failedCount: number;
        total: number;
      }>(`/api/projects/${projectId}/verification`),
    staleTime: 5_000,
  });

  const runMut = useMutation({
    mutationFn: () =>
      apiPost(`/api/projects/${projectId}/verification/run`),
    onSuccess: () => {
      toast({ title: "Readiness gate re-run" });
      qc.invalidateQueries({ queryKey: ["verification", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Re-run failed",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const checks = q.data?.checks ?? [];
  const grouped = groupByCategory(checks);

  return (
    <div className="space-y-4">
      {/* Gate banner */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="size-4" />
                Production readiness gate
              </CardTitle>
              <CardDescription>
                {q.data?.total ?? 0} checks across {Object.keys(grouped).length}{" "}
                categories.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runMut.mutate()}
              disabled={runMut.isPending || q.isLoading}
            >
              {runMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Re-run Readiness Gate
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between",
                q.data?.passed
                  ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30"
                  : "border-destructive/40 bg-destructive/5"
              )}
            >
              <div className="flex items-center gap-3">
                {q.data?.passed ? (
                  <CheckCircle2 className="size-7 text-emerald-500" />
                ) : (
                  <XCircle className="size-7 text-destructive" />
                )}
                <div>
                  <p className="font-semibold">
                    {q.data?.passed ? "Gate passed" : "Gate failed"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {q.data?.passedCount ?? 0} passed · {q.data?.failedCount ?? 0}{" "}
                    failed · {q.data?.total ?? 0} total
                  </p>
                </div>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "text-sm",
                  q.data?.passed
                    ? "text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
                    : "text-destructive border-destructive/40"
                )}
              >
                {q.data?.passed ? "PRODUCTION READY" : "NOT READY"}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Checks grouped by category */}
      <div className="space-y-3">
        {q.isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)
        ) : Object.keys(grouped).length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No readiness checks yet. Run the gate to evaluate.
            </CardContent>
          </Card>
        ) : (
          Object.entries(grouped).map(([cat, catChecks]) => (
            <Card key={cat}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <span>{CATEGORY_LABELS[cat] ?? cat}</span>
                  <CategorySummaryBadge checks={catChecks} />
                </CardTitle>
                <CardDescription>
                  {catChecks.length} check{catChecks.length === 1 ? "" : "s"}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {catChecks.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

function groupByCategory(checks: ReadinessCheck[]): Record<string, ReadinessCheck[]> {
  const out: Record<string, ReadinessCheck[]> = {};
  // Keep canonical order
  const order = [...Object.values(ReadinessCategory), "REVIEW"];
  for (const c of checks) {
    const k = c.category || "OTHER";
    (out[k] ??= []).push(c);
  }
  const sorted: Record<string, ReadinessCheck[]> = {};
  for (const cat of order) if (out[cat]) sorted[cat] = out[cat];
  for (const k of Object.keys(out)) if (!sorted[k]) sorted[k] = out[k];
  return sorted;
}

function CategorySummaryBadge({ checks }: { checks: ReadinessCheck[] }) {
  const failed = checks.filter((c) => c.status === "FAILED").length;
  const passed = checks.filter((c) => c.status === "PASSED").length;
  const tone = failed > 0 ? "red" : passed === checks.length ? "emerald" : "amber";
  const label = failed > 0 ? `${failed} failing` : passed === checks.length ? "all passing" : "incomplete";
  const toneCls =
    tone === "red"
      ? "text-destructive border-destructive/40"
      : tone === "emerald"
        ? "text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
        : "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800";
  return (
    <Badge variant="outline" className={cn("text-[10px]", toneCls)}>
      {label}
    </Badge>
  );
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border p-3">
        <CollapsibleTrigger className="flex w-full items-start justify-between gap-2 text-left">
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-sm">{check.name}</p>
            {check.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {check.description}
              </p>
            )}
            {check.checkedAt && (
              <p className="text-[10px] text-muted-foreground">
                checked {formatRelative(check.checkedAt)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ReadinessStatusBadge status={check.status} />
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          </div>
        </CollapsibleTrigger>
        {check.status === "FAILED" && check.failureReason && (
          <p className="mt-2 text-xs text-destructive">{check.failureReason}</p>
        )}
        <CollapsibleContent>
          {check.evidence != null && (
            <ScrollArea className="mt-2 max-h-60">
              <pre className="rounded-md bg-muted p-2 text-xs font-mono overflow-auto whitespace-pre-wrap break-words">
                {typeof check.evidence === "string"
                  ? check.evidence
                  : JSON.stringify(check.evidence, null, 2)}
              </pre>
            </ScrollArea>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
