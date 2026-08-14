"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Cpu,
  Loader2,
  Settings2,
  Sparkles,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "../lib/api";
import { AGENT_META, AgentType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AgentBadge, AgentStateBadge } from "../status-badge";
import { formatCost, formatRelative, formatTokens } from "../lib/format";
import type { AgentAssignment, BuildEvent, LlmProvider } from "../lib/types";

const ALL_AGENT_TYPES = Object.values(AgentType) as AgentType[];

export function AgentsTab({ projectId }: { projectId: string }) {
  const agentsQ = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () =>
      apiGet<{ agents: AgentAssignment[] }>(`/api/projects/${projectId}/agents`),
    staleTime: 5_000,
  });
  const providersQ = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: LlmProvider[] }>("/api/providers"),
    staleTime: 30_000,
  });

  const agents = agentsQ.data?.agents ?? [];
  const byType = new Map(agents.map((a) => [a.agentType, a]));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {ALL_AGENT_TYPES.map((type) => (
          <AgentCard
            key={type}
            projectId={projectId}
            type={type}
            assignment={byType.get(type)}
            providers={providersQ.data?.providers ?? []}
            providersLoading={providersQ.isLoading}
          />
        ))}
      </div>
    </div>
  );
}

function AgentCard({
  projectId,
  type,
  assignment,
  providers,
  providersLoading,
}: {
  projectId: string;
  type: AgentType;
  assignment?: AgentAssignment;
  providers: LlmProvider[];
  providersLoading: boolean;
}) {
  const meta = AGENT_META[type];
  const qc = useQueryClient();
  const { toast } = useToast();
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<string | undefined>(
    assignment?.providerId ?? undefined
  );

  const eventsQ = useQuery({
    queryKey: ["agent-events", projectId, type],
    queryFn: () =>
      apiGet<{ events: BuildEvent[] }>(
        `/api/projects/${projectId}/events?limit=50`
      ),
    select: (d) =>
      (d.events ?? [])
        .filter((e) => e.agentType === type)
        .slice(0, 5),
    staleTime: 10_000,
  });

  const assignMut = useMutation({
    mutationFn: (providerId: string | null) =>
      apiPost<{ assignment: AgentAssignment }>(
        `/api/projects/${projectId}/agents/assign`,
        { agentType: type, providerId }
      ),
    onSuccess: () => {
      toast({ title: "Provider assigned" });
      setAssignOpen(false);
      qc.invalidateQueries({ queryKey: ["agents", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Failed to assign",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <AgentBadge agentType={type} />
            </CardTitle>
            <CardDescription className="line-clamp-2 min-h-[2.5rem]">
              {meta.description}
            </CardDescription>
          </div>
          <AgentStateBadge state={assignment?.state ?? "IDLE"} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat label="Model" value={assignment?.provider?.model ?? "Default (z-ai sandbox)"} mono />
          <Stat label="Last activity" value={formatRelative(assignment?.lastActivity)} />
          <Stat label="Tokens used" value={formatTokens(assignment?.tokensUsed ?? 0)} />
          <Stat label="Cost" value={formatCost(assignment?.costUsd ?? 0)} />
        </div>

        {assignment?.currentTaskId && (
          <div className="rounded-md border p-2 text-xs">
            <span className="text-muted-foreground">Current task: </span>
            <span className="font-mono">{assignment.currentTaskId.slice(0, 8)}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-1">
          {meta.permissions.map((p) => (
            <Badge key={p} variant="outline" className="text-[10px] py-0 font-mono">
              {p}
            </Badge>
          ))}
        </div>

        <Collapsible>
          <CollapsibleTrigger className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground">
            <span>Recent executions ({eventsQ.data?.length ?? 0})</span>
            <ChevronDown className="size-3.5" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {(eventsQ.data ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground py-2">No executions yet.</p>
              )}
              {(eventsQ.data ?? []).map((e) => (
                <div key={e.id} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {e.type}
                    </Badge>
                    <span className="text-muted-foreground">
                      {formatRelative(e.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2">{e.message}</p>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
      <div className="px-6 pb-6 pt-0 flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPicked(assignment?.providerId ?? undefined);
            setAssignOpen(true);
          }}
        >
          <Settings2 className="size-4" />
          Assign Provider
        </Button>
      </div>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AgentBadge agentType={type} />
              Assign LLM provider
            </DialogTitle>
            <DialogDescription>
              Pick a configured provider for {meta.label}. Unassigned agents use
              the default <code>zai</code> sandbox.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {providersLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No providers configured. Open “LLM Providers” in the top bar to
                add one.
              </p>
            ) : (
              <Select value={picked ?? "__default__"} onValueChange={(v) => setPicked(v === "__default__" ? undefined : v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    <span className="flex items-center gap-2">
                      <Sparkles className="size-3.5" />
                      Default (z-ai sandbox)
                    </span>
                  </SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <Cpu className="size-3.5" />
                        {p.name} · <span className="font-mono text-xs">{p.model}</span>
                        {p.isDefault && <Badge className="text-[10px]">default</Badge>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={assignMut.isPending || providersLoading}
              onClick={() => assignMut.mutate(picked ?? null)}
            >
              {assignMut.isPending && <Loader2 className="size-4 animate-spin" />}
              Save assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground truncate">{label}</p>
      <p className={cn("font-medium truncate", mono && "font-mono text-xs")}>{value}</p>
    </div>
  );
}
