"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

import { apiGet } from "../lib/api";
import { formatTime } from "../lib/format";
import type { BuildEvent } from "../lib/types";
import { AgentBadge } from "../status-badge";

const LEVELS = ["ALL", "INFO", "SUCCESS", "WARN", "ERROR"] as const;

export function BuildLogTab({
  projectId,
  live,
}: {
  projectId: string;
  live: boolean;
}) {
  const [level, setLevel] = React.useState<(typeof LEVELS)[number]>("ALL");

  const q = useQuery({
    queryKey: ["events", projectId, "log"],
    queryFn: () =>
      apiGet<{ events: BuildEvent[] }>(
        `/api/projects/${projectId}/events?limit=200`
      ),
    // auto-refresh every 2s when build is active
    refetchInterval: live ? 2000 : false,
  });

  const events = (q.data?.events ?? []).slice().reverse(); // newest first
  const filtered = events.filter((e) =>
    level === "ALL" ? true : (e.level || "INFO").toUpperCase() === level
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="size-4" />
                Build log
                {live && (
                  <Badge className="bg-orange-500 text-white border-transparent gap-1">
                    <span className="size-1.5 rounded-full bg-white animate-pulse" />
                    live
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Newest first · {filtered.length} event(s) shown.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {LEVELS.map((l) => (
                <Button
                  key={l}
                  size="sm"
                  variant={level === l ? "default" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setLevel(l)}
                >
                  {l}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-[600px] -mx-2 px-2">
            {q.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No events match the current filter.
              </div>
            ) : (
              <ol className="space-y-1.5">
                {filtered.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-2 rounded-md border p-2.5 text-sm hover:bg-accent/40 transition-colors"
                  >
                    <LevelIcon level={e.level} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {formatTime(e.createdAt)}
                        </span>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {e.type}
                        </Badge>
                        {e.agentType && <AgentBadge agentType={e.agentType} />}
                        {e.taskId && (
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            task {e.taskId.slice(0, 6)}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 break-words">{e.message}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function LevelIcon({ level }: { level?: string | null }) {
  const l = (level || "INFO").toUpperCase();
  if (l === "ERROR")
    return <XCircle className="size-4 mt-0.5 text-destructive shrink-0" />;
  if (l === "WARN")
    return <AlertTriangle className="size-4 mt-0.5 text-amber-500 shrink-0" />;
  if (l === "SUCCESS")
    return <CheckCircle2 className="size-4 mt-0.5 text-emerald-500 shrink-0" />;
  return <Info className="size-4 mt-0.5 text-muted-foreground shrink-0" />;
}
