"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Loader2,
  RotateCcw,
  Search,
  Terminal,
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "../lib/api";
import { cn } from "@/lib/utils";
import { AgentBadge, TaskStatusBadge } from "../status-badge";
import { formatRelative, formatDuration, toneClasses } from "../lib/format";
import type { Task } from "../lib/types";
import { TaskStatus } from "@/lib/types";

const FILTERS: { value: string; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PLANNED", label: "Planned" },
  { value: "RUNNING", label: "Running" },
  { value: "COMPLETED", label: "Completed" },
  { value: "FAILED", label: "Failed" },
];

export function TasksTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = React.useState("ALL");
  const [query, setQuery] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => apiGet<{ tasks: Task[] }>(`/api/projects/${projectId}/tasks`),
    staleTime: 5_000,
  });

  const retryMut = useMutation({
    mutationFn: (taskId: string) =>
      apiPost<{ task: Task }>(`/api/projects/${projectId}/tasks/${taskId}/retry`),
    onSuccess: () => {
      toast({ title: "Task queued for retry" });
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Retry failed",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const tasks = tasksQ.data?.tasks ?? [];
  const filtered = tasks.filter((t) => {
    if (filter !== "ALL" && t.status !== filter) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      return (
        t.code.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.component ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Tasks</CardTitle>
              <CardDescription>
                {tasks.length} task{tasks.length === 1 ? "" : "s"} derived from
                the architecture.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search…"
                  className="pl-8 h-8 w-40"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <Button
                key={f.value}
                size="sm"
                variant={filter === f.value ? "default" : "outline"}
                onClick={() => setFilter(f.value)}
                className="h-7 px-2.5 text-xs"
              >
                {f.label}
              </Button>
            ))}
          </div>

          {tasksQ.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No tasks match the current filter.
            </div>
          ) : (
            <ScrollArea className="max-h-[600px] -mx-2 px-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Code</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="w-32">Agent</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-24 hidden md:table-cell">Priority</TableHead>
                    <TableHead className="w-20 hidden sm:table-cell">Attempts</TableHead>
                    <TableHead className="w-32 hidden lg:table-cell">Deps</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(t.id)}
                    >
                      <TableCell className="font-mono text-xs">{t.code}</TableCell>
                      <TableCell className="max-w-[260px] truncate">
                        {t.title}
                      </TableCell>
                      <TableCell>
                        <AgentBadge agentType={t.agentType} />
                      </TableCell>
                      <TableCell>
                        <TaskStatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {t.priority ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs">
                        {t.attempts ?? 0}/{t.maxAttempts ?? 3}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                        {(t.dependencies ?? []).length ? (
                          <span className="font-mono">
                            {(t.dependencies ?? []).join(", ")}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <TaskDetailSheet
        task={selected}
        open={!!selected}
        onOpenChange={(o) => !o && setSelectedId(null)}
        onRetry={(id) => retryMut.mutate(id)}
        retrying={retryMut.isPending}
      />
    </div>
  );
}

function TaskDetailSheet({
  task,
  open,
  onOpenChange,
  onRetry,
  retrying,
}: {
  task: Task | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-y-auto p-0"
      >
        <SheetHeader className="p-4 border-b">
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {task && <Badge variant="outline" className="font-mono">{task.code}</Badge>}
            <span className="truncate">{task?.title}</span>
          </SheetTitle>
          <SheetDescription className="sr-only">Task detail</SheetDescription>
        </SheetHeader>
        {task && (
          <div className="p-4 space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <AgentBadge agentType={task.agentType} />
              <TaskStatusBadge status={task.status} />
              {task.priority && (
                <Badge variant="outline" className="text-[10px]">
                  {task.priority}
                </Badge>
              )}
              {task.component && (
                <Badge variant="secondary" className="text-[10px]">
                  {task.component}
                </Badge>
              )}
            </div>

            {task.description && (
              <Section title="Description">
                <p className="text-muted-foreground">{task.description}</p>
              </Section>
            )}

            {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
              <Section title="Acceptance criteria">
                <ul className="list-disc pl-5 text-muted-foreground space-y-1">
                  {task.acceptanceCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </Section>
            )}

            {task.requiredTests && task.requiredTests.length > 0 && (
              <Section title="Required tests">
                <ul className="list-disc pl-5 text-muted-foreground space-y-1">
                  {task.requiredTests.map((t, i) => (
                    <li key={i} className="font-mono text-xs">
                      {t}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {task.filesChanged && task.filesChanged.length > 0 && (
              <Section title={`Files changed (${task.filesChanged.length})`}>
                <div className="flex flex-wrap gap-1">
                  {task.filesChanged.map((f, i) => (
                    <Badge key={i} variant="secondary" className="font-mono text-[10px]">
                      {f}
                    </Badge>
                  ))}
                </div>
              </Section>
            )}

            {task.testResults && task.testResults.length > 0 && (
              <Section title="Test results">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead className="w-24">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {task.testResults.map((r: any, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">
                          {r.name ?? r.test ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px]",
                              r.status === "PASS" || r.passed
                                ? "text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
                                : "text-destructive border-destructive/40"
                            )}
                          >
                            {r.status ?? (r.passed ? "PASS" : "FAIL")}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
            )}

            {task.guardianResult && (
              <Section title="Guardian review">
                <VerdictBlock
                  verdict={task.guardianResult.verdict}
                  violations={task.guardianResult.violations}
                />
              </Section>
            )}

            {task.reviewResult && (
              <Section title="Code review">
                <VerdictBlock
                  verdict={task.reviewResult.verdict}
                  findings={task.reviewResult.findings}
                />
              </Section>
            )}

            {task.failureReason && (
              <Alert variant="destructive">
                <AlertTitle>Failure reason</AlertTitle>
                <AlertDescription>{task.failureReason}</AlertDescription>
              </Alert>
            )}
            {task.blockedReason && (
              <Alert>
                <AlertTitle>Blocked</AlertTitle>
                <AlertDescription>{task.blockedReason}</AlertDescription>
              </Alert>
            )}

            {task.implementationLog && (
              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border p-2 text-left text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Terminal className="size-4" />
                    Implementation log
                  </span>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words">
                    {task.implementationLog}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}

            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              {task.branchName && (
                <div>
                  <span className="font-medium text-foreground">Branch:</span>{" "}
                  <span className="font-mono">{task.branchName}</span>
                </div>
              )}
              {task.commitSha && (
                <div>
                  <span className="font-medium text-foreground">Commit:</span>{" "}
                  <span className="font-mono">{task.commitSha.slice(0, 7)}</span>
                </div>
              )}
              {task.startedAt && (
                <div>
                  <span className="font-medium text-foreground">Started:</span>{" "}
                  {formatRelative(task.startedAt)}
                </div>
              )}
              {task.completedAt && (
                <div>
                  <span className="font-medium text-foreground">Completed:</span>{" "}
                  {formatRelative(task.completedAt)}
                  {task.startedAt && (
                    <span>
                      {" "}
                      (took {formatDuration(
                        new Date(task.completedAt).getTime() -
                          new Date(task.startedAt).getTime()
                      )})
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              {task.status === TaskStatus.FAILED && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRetry(task.id)}
                  disabled={retrying}
                >
                  {retrying ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  Retry task
                </Button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function VerdictBlock({
  verdict,
  violations,
  findings,
}: {
  verdict?: string;
  violations?: any[];
  findings?: any[];
}) {
  const tone = verdict === "PASS" || verdict === "PASSED" ? "emerald" : verdict === "WARNING" ? "amber" : "red";
  const cls = toneClasses(tone);
  const items = violations ?? findings ?? [];
  return (
    <div className="space-y-2">
      {verdict && (
        <Badge variant="outline" className={cn("font-medium", cls.soft)}>
          <span className={cn("inline-block size-1.5 rounded-full", cls.dot)} />
          {verdict}
        </Badge>
      )}
      {items.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {items.map((v, i) => (
            <li key={i} className="rounded-md border p-2">
              {typeof v === "string" ? v : v.message ?? v.description ?? JSON.stringify(v)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
