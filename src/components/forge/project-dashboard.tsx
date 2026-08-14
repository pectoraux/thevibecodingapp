"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Boxes,
  Building2,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Play,
  Rocket,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "./lib/api";
import { ProjectStatus } from "@/lib/types";
import type { ProjectDetail, BuildStatus } from "./lib/types";
import { useForgeStore, type ForgeTab } from "./lib/store";
import { ProjectStatusBadge } from "./status-badge";

import { OverviewTab } from "./tabs/overview";
import { ArchitectureTab } from "./tabs/architecture";
import { TasksTab } from "./tabs/tasks";
import { AgentsTab } from "./tabs/agents";
import { RepositoryTab } from "./tabs/repository";
import { VerificationTab } from "./tabs/verification";
import { CredentialsTab } from "./tabs/credentials";
import { BuildLogTab } from "./tabs/build-log";

const TABS: { value: ForgeTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "architecture", label: "Architecture" },
  { value: "tasks", label: "Tasks" },
  { value: "agents", label: "Agents" },
  { value: "repository", label: "Repository" },
  { value: "verification", label: "Verification" },
  { value: "credentials", label: "Credentials" },
  { value: "build-log", label: "Build Log" },
];

// Statuses at which the autonomous loop has stopped and polling should cease.
const TERMINAL_STATUSES: string[] = [
  ProjectStatus.PRODUCTION_READY,
  ProjectStatus.FAILED,
  ProjectStatus.HUMAN_REVIEW_REQUIRED,
  ProjectStatus.DEPLOYED,
];
void TERMINAL_STATUSES;

export function ProjectDashboard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const activeTab = useForgeStore((s) => s.activeTab);
  const setActiveTab = useForgeStore((s) => s.setActiveTab);
  const back = useForgeStore((s) => s.setSelectedProjectId);
  const setProvidersOpen = useForgeStore((s) => s.setProvidersModalOpen);

  const detailQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      apiGet<{ project: ProjectDetail; architecture?: any; counts: any }>(
        `/api/projects/${projectId}`
      ),
    enabled: !!projectId,
    // poll while building/verifying/architecting
    refetchInterval: (q) => {
      const status = q.state.data?.project?.status;
      if (
        status === ProjectStatus.BUILDING ||
        status === ProjectStatus.VERIFYING ||
        status === ProjectStatus.ARCHITECTING
      ) {
        return 2500;
      }
      return false;
    },
  });

  const statusQ = useQuery({
    queryKey: ["build-status", projectId],
    queryFn: () =>
      apiGet<BuildStatus>(`/api/projects/${projectId}/build/status`),
    enabled: !!projectId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (
        status === ProjectStatus.BUILDING ||
        status === ProjectStatus.VERIFYING
      ) {
        return 2000;
      }
      return false;
    },
  });

  const project = detailQ.data?.project;
  const status = statusQ.data?.status ?? project?.status;
  const isBuilding = status === ProjectStatus.BUILDING;
  const isVerifying = status === ProjectStatus.VERIFYING;
  const isArchitecting = status === ProjectStatus.ARCHITECTING;
  const isBusy = isBuilding || isVerifying || isArchitecting;

  // Phase 6: When the build is running and the server says to trigger a
  // scheduler tick, POST to /api/scheduler/tick to process the next job.
  // This is the local-mode equivalent of a worker polling loop.
  const triggerTick = statusQ.data?.triggerSchedulerTick;
  const tickMut = useMutation({
    mutationFn: () => apiPost("/api/scheduler/tick", {}),
    onError: () => {}, // silent — ticks are best-effort
  });
  React.useEffect(() => {
    if (triggerTick && !tickMut.isPending) {
      tickMut.mutate();
    }
  }, [triggerTick, statusQ.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const [buildOpen, setBuildOpen] = React.useState(false);
  const [longOp, setLongOp] = React.useState<null | "build">(null);

  const buildMut = useMutation({
    mutationFn: () => apiPost<{ project: ProjectDetail }>(`/api/projects/${projectId}/build`),
    onMutate: () => setLongOp("build"),
    onSuccess: () => {
      toast({ title: "Build finished", description: "Refreshing project state." });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["build-status", projectId] });
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      qc.invalidateQueries({ queryKey: ["events", projectId] });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Build failed",
        description: err instanceof Error ? err.message : undefined,
      });
    },
    onSettled: () => {
      setLongOp(null);
      setBuildOpen(false);
    },
  });

  const canStartBuild =
    project?.status === ProjectStatus.ARCHITECTURE_FROZEN ||
    project?.status === ProjectStatus.PREFLIGHT;

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => back(null)}
            className="shrink-0"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Projects</span>
          </Button>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate">
                {project?.name ?? <Skeleton className="h-6 w-40" />}
              </h1>
              {status && <ProjectStatusBadge status={status} />}
            </div>
            {project?.description && (
              <p className="text-sm text-muted-foreground line-clamp-1">
                {project.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setProvidersOpen(true)}>
            <Boxes className="size-4" />
            <span className="hidden sm:inline">Providers</span>
          </Button>
          {project?.status === ProjectStatus.BLOCKED && (
            <Badge variant="outline" className="text-destructive border-destructive/40">
              <CircleAlert className="size-3" />
              Blocked
            </Badge>
          )}
          <Button
            size="sm"
            disabled={
              !canStartBuild ||
              buildMut.isPending ||
              isBusy
            }
            onClick={() => setBuildOpen(true)}
            title={
              !canStartBuild
                ? "Freeze architecture and pass preflight before starting a build."
                : undefined
            }
          >
            {isBusy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {isBuilding ? "Building…" : isVerifying ? "Verifying…" : "Start Build"}
          </Button>
        </div>
      </div>

      {/* Blocked / failure banner */}
      {project?.status === ProjectStatus.BLOCKED && project.blockedReason && (
        <Alert variant="destructive">
          <CircleAlert className="size-4" />
          <AlertTitle>Build blocked</AlertTitle>
          <AlertDescription>{project.blockedReason}</AlertDescription>
        </Alert>
      )}
      {project?.status === ProjectStatus.FAILED && project.failureReason && (
        <Alert variant="destructive">
          <CircleAlert className="size-4" />
          <AlertTitle>Build failed</AlertTitle>
          <AlertDescription>{project.failureReason}</AlertDescription>
        </Alert>
      )}
      {project?.status === ProjectStatus.HUMAN_REVIEW_REQUIRED && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertTitle>Human review required</AlertTitle>
          <AlertDescription>
            The autonomous loop paused for human judgement. Inspect the
            verification tab, then approve or revise.
          </AlertDescription>
        </Alert>
      )}

      {/* Live build progress strip */}
      {isBusy && statusQ.data && (
        <BuildProgressStrip data={statusQ.data} />
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ForgeTab)}>
        <div className="overflow-x-auto -mx-1 px-1 pb-1">
          <TabsList className="w-max">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            <TabsContent value={activeTab} className="mt-2 focus-visible:outline-none">
              {activeTab === "overview" && (
                <OverviewTab projectId={projectId} detail={detailQ.data} status={statusQ.data} />
              )}
              {activeTab === "architecture" && (
                <ArchitectureTab projectId={projectId} />
              )}
              {activeTab === "tasks" && <TasksTab projectId={projectId} />}
              {activeTab === "agents" && <AgentsTab projectId={projectId} />}
              {activeTab === "repository" && (
                <RepositoryTab projectId={projectId} />
              )}
              {activeTab === "verification" && (
                <VerificationTab projectId={projectId} />
              )}
              {activeTab === "credentials" && (
                <CredentialsTab projectId={projectId} />
              )}
              {activeTab === "build-log" && (
                <BuildLogTab projectId={projectId} live={isBusy} />
              )}
            </TabsContent>
          </motion.div>
        </AnimatePresence>
      </Tabs>

      {/* Start build confirmation */}
      <Dialog open={buildOpen} onOpenChange={setBuildOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="size-5" />
              Start autonomous build?
            </DialogTitle>
            <DialogDescription>
              Agents will implement, test, review, and verify every task in the
              architecture. This can take 1–5 minutes. You can watch progress in
              the Build Log tab.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBuildOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={buildMut.isPending}
              onClick={() => buildMut.mutate()}
            >
              {buildMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Building2 className="size-4" />
              )}
              Launch build
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Long-running overlay */}
      <LongRunningOverlay
        open={longOp === "build"}
        title="Autonomous build in progress"
        description="Implementation, testing, review and verification agents are running. This may take 1–5 minutes. The dashboard will refresh automatically."
      />
    </div>
  );
}

function BuildProgressStrip({ data }: { data: BuildStatus }) {
  const total = data.totalTasks || 0;
  const done = data.completedTasks || 0;
  const failed = data.failedTasks || 0;
  const pct = total ? Math.round(((done + failed) / total) * 100) : 0;
  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium">
          {data.status === ProjectStatus.VERIFYING ? "Verifying" : "Building"} ·{" "}
          {done + failed}/{total} tasks resolved
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-foreground/70 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {data.currentTask && (
        <p className="text-xs text-muted-foreground truncate">
          Now: <span className="font-mono">{data.currentTask.code}</span> —{" "}
          {data.currentTask.title}
        </p>
      )}
    </div>
  );
}

function LongRunningOverlay({
  open,
  title,
  description,
}: {
  open: boolean;
  title: string;
  description: string;
}) {
  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-foreground/10" />
            <div className="relative rounded-full bg-muted p-4">
              <Loader2 className="size-8 animate-spin text-foreground" />
            </div>
          </div>
          <div className="space-y-1">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription className="max-w-sm">{description}</DialogDescription>
          </div>
          <p className="text-xs text-muted-foreground">
            You can keep this page open — it refreshes automatically.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
