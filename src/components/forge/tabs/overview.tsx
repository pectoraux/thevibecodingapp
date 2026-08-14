"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  GitCommitHorizontal,
  ListChecks,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

import { apiGet } from "../lib/api";
import { formatRelative } from "../lib/format";
import type {
  BuildEvent,
  ProjectDetail,
  ReadinessCheck,
  Task,
  BuildStatus,
} from "../lib/types";
import { ReadinessCategory } from "@/lib/types";
import { StateStepper } from "../state-stepper";
import { AgentBadge, READINESS_TONE, ToneBadge } from "../status-badge";

interface OverviewProps {
  projectId: string;
  detail?: { project: ProjectDetail; architecture?: any; counts: any } | undefined;
  status?: BuildStatus | undefined;
}

export function OverviewTab({ projectId, detail, status }: OverviewProps) {
  const project = detail?.project;
  const counts = detail?.counts;

  const eventsQ = useQuery({
    queryKey: ["events", projectId, 10],
    queryFn: () =>
      apiGet<{ events: BuildEvent[] }>(
        `/api/projects/${projectId}/events?limit=10`
      ),
    refetchInterval: status?.status === "BUILDING" || status?.status === "VERIFYING" ? 3000 : false,
  });

  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => apiGet<{ tasks: Task[] }>(`/api/projects/${projectId}/tasks`),
    staleTime: 5_000,
  });
  const failedTasks = (tasksQ.data?.tasks ?? []).filter(
    (t) => t.status === "FAILED"
  );

  const verificationQ = useQuery({
    queryKey: ["verification", projectId],
    queryFn: () =>
      apiGet<{ checks: ReadinessCheck[]; passed: boolean; passedCount: number; failedCount: number; total: number }>(
        `/api/projects/${projectId}/verification`
      ),
  });

  return (
    <div className="space-y-4">
      {/* State machine */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle</CardTitle>
          <CardDescription>
            The autonomous pipeline moves left-to-right; off-path states are
            shown separately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {project ? (
            <StateStepper current={project.status} />
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </CardContent>
      </Card>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<ListChecks className="size-4" />}
          label="Total tasks"
          value={counts?.tasks}
          loading={!counts}
        />
        <StatCard
          icon={<CheckCircle2 className="size-4" />}
          label="Completed"
          value={counts?.completedTasks}
          tone="emerald"
          loading={!counts}
        />
        <StatCard
          icon={<XCircle className="size-4" />}
          label="Failed"
          value={counts?.failedTasks}
          tone={counts?.failedTasks ? "red" : "slate"}
          loading={!counts}
        />
        <StatCard
          icon={<Users className="size-4" />}
          label="Agents active"
          value={counts?.agents}
          loading={!counts}
        />
        <StatCard
          icon={<ShieldCheck className="size-4" />}
          label="Credentials"
          value={
            counts
              ? `${counts.configuredCredentials}/${counts.credentials}`
              : undefined
          }
          loading={!counts}
        />
        <StatCard
          icon={<FileCode2 className="size-4" />}
          label="Files in repo"
          value={counts?.files}
          loading={!counts}
        />
        <StatCard
          icon={<GitCommitHorizontal className="size-4" />}
          label="Commits"
          value={counts?.commits}
          loading={!counts}
        />
        <StatCard
          icon={<Activity className="size-4" />}
          label="Build events"
          value={counts?.events}
          loading={!counts}
        />
      </div>

      {/* Blockers */}
      {failedTasks.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-4" />
              Blockers
            </CardTitle>
            <CardDescription>
              Failed tasks and missing credentials block the build pipeline.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {failedTasks.map((t) => (
              <div
                key={t.id}
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs">{t.code}</span>
                  <span className="font-medium">{t.title}</span>
                  <AgentBadge agentType={t.agentType} />
                </div>
                {t.failureReason && (
                  <p className="mt-1 text-xs text-destructive">
                    {t.failureReason}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="size-4" />
            Recent activity
          </CardTitle>
          <CardDescription>Last 10 build events.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-96 pr-3 -mr-3">
            <div className="space-y-2">
              {eventsQ.isLoading &&
                [0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              {eventsQ.data?.events?.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No events yet.
                </p>
              )}
              {(eventsQ.data?.events ?? []).map((e) => (
                <div
                  key={e.id}
                  className="flex items-start gap-3 rounded-md border p-2.5 text-sm"
                >
                  <EventLevelIcon level={e.level} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {e.type}
                      </Badge>
                      {e.agentType && <AgentBadge agentType={e.agentType} />}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {formatRelative(e.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm">{e.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Production readiness summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="size-4" />
            Production readiness
          </CardTitle>
          <CardDescription>
            12 readiness categories plus a final review gate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {verificationQ.isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {Array.from({ length: 13 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : (
            <ReadinessSummary checks={verificationQ.data?.checks ?? []} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone = "slate",
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value?: number | string | null;
  tone?: "slate" | "emerald" | "red";
  loading?: boolean;
}) {
  const toneText =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "red"
        ? "text-destructive"
        : "text-foreground";
  return (
    <Card className="py-0">
      <CardContent className="p-4 flex items-center gap-3">
        <div className="rounded-md bg-muted p-2 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          {loading ? (
            <Skeleton className="h-5 w-10 mt-1" />
          ) : (
            <p className={`text-lg font-semibold ${toneText}`}>
              {value ?? 0}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventLevelIcon({ level }: { level?: string | null }) {
  const l = (level || "info").toUpperCase();
  if (l === "ERROR")
    return <XCircle className="size-4 mt-0.5 text-destructive shrink-0" />;
  if (l === "WARN")
    return <AlertTriangle className="size-4 mt-0.5 text-amber-500 shrink-0" />;
  if (l === "SUCCESS")
    return <CheckCircle2 className="size-4 mt-0.5 text-emerald-500 shrink-0" />;
  return <Activity className="size-4 mt-0.5 text-muted-foreground shrink-0" />;
}

const READINESS_CATEGORY_LABELS: Record<string, string> = {
  BUILD: "Build",
  STATIC: "Static",
  TESTS: "Tests",
  RUNTIME: "Runtime",
  INTEGRATIONS: "Integrations",
  DATA: "Data",
  AUTH: "Auth",
  ERRORS: "Errors",
  OBSERVABILITY: "Observability",
  SECURITY: "Security",
  CONFIG: "Config",
  DEPLOYMENT: "Deployment",
};

function ReadinessSummary({ checks }: { checks: ReadinessCheck[] }) {
  const categories = Object.values(ReadinessCategory) as string[];
  const reviewCheck = checks.find((c) => c.category === "REVIEW");

  function categoryStatus(cat: string): string {
    const inCat = checks.filter((c) => c.category === cat);
    if (inCat.length === 0) return "PENDING";
    if (inCat.some((c) => c.status === "FAILED")) return "FAILED";
    if (inCat.every((c) => c.status === "PASSED")) return "PASSED";
    return "PENDING";
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {categories.map((cat) => {
          const st = categoryStatus(cat);
          const tone = READINESS_TONE[st] ?? "slate";
          return (
            <ToneBadge key={cat} tone={tone} withDot className="justify-between w-full py-1.5">
              <span className="truncate">{READINESS_CATEGORY_LABELS[cat] ?? cat}</span>
            </ToneBadge>
          );
        })}
      </div>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono">
            REVIEW
          </Badge>
          <span className="text-sm font-medium">Final human review gate</span>
        </div>
        {reviewCheck ? (
          <ReadinessStatusBadgeWrap status={reviewCheck.status} />
        ) : (
          <ToneBadge tone="slate">PENDING</ToneBadge>
        )}
      </div>
    </div>
  );
}

function ReadinessStatusBadgeWrap({ status }: { status: string }) {
  // reuse the readiness tone mapping
  return (
    <Badge variant="outline" className={status === "PASSED" ? "text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800" : status === "FAILED" ? "text-destructive border-destructive/40" : ""}>
      {status}
    </Badge>
  );
}
