"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import { apiGet } from "../lib/api";
import { cn } from "@/lib/utils";
import { formatBytes, formatRelative, shortSha } from "../lib/format";
import type {
  PullRequest,
  RepoBranch,
  RepoCommit,
  RepoFile,
} from "../lib/types";
import { SUSPICIOUS_PATTERNS } from "@/lib/types";

export function RepositoryTab({ projectId }: { projectId: string }) {
  const repoQ = useQuery({
    queryKey: ["repository", projectId],
    queryFn: () =>
      apiGet<{
        branches: RepoBranch[];
        commits: RepoCommit[];
        files: RepoFile[];
        pullRequests: PullRequest[];
      }>(`/api/projects/${projectId}/repository`),
    staleTime: 10_000,
  });

  const [openFile, setOpenFile] = React.useState<RepoFile | null>(null);
  const [openCommit, setOpenCommit] = React.useState<RepoCommit | null>(null);

  const branches = repoQ.data?.branches ?? [];
  const commits = repoQ.data?.commits ?? [];
  const files = repoQ.data?.files ?? [];
  const prs = repoQ.data?.pullRequests ?? [];

  return (
    <div className="space-y-4">
      {/* Branches */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GitBranch className="size-4" />
            Branches
          </CardTitle>
          <CardDescription>{branches.length} branch(es).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {repoQ.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : branches.length === 0 ? (
            <EmptyRow label="No branches yet." />
          ) : (
            branches.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded-md border p-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <GitBranch className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono truncate">{b.name}</span>
                  {b.isDefault && (
                    <Badge variant="secondary" className="text-[10px]">
                      default
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {shortSha(b.headSha)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Commits */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GitCommitHorizontal className="size-4" />
            Commits
          </CardTitle>
          <CardDescription>{commits.length} commit(s).</CardDescription>
        </CardHeader>
        <CardContent>
          {repoQ.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : commits.length === 0 ? (
            <EmptyRow label="No commits yet." />
          ) : (
            <ScrollArea className="max-h-96 -mx-2 px-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">SHA</TableHead>
                    <TableHead className="w-28 hidden sm:table-cell">Branch</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-32 hidden md:table-cell">Author</TableHead>
                    <TableHead className="w-24 hidden lg:table-cell">When</TableHead>
                    <TableHead className="w-16">Files</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {commits.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => setOpenCommit(c)}
                    >
                      <TableCell className="font-mono text-xs">
                        {shortSha(c.sha)}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell font-mono text-xs text-muted-foreground">
                        {c.branch}
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate text-sm">
                        {c.message}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {c.author}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                        {formatRelative(c.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {c.filesChanged?.length ?? 0}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Files */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileCode2 className="size-4" />
            Files
          </CardTitle>
          <CardDescription>
            {files.length} file(s) in the working tree.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {repoQ.isLoading ? (
            <Skeleton className="h-60 w-full" />
          ) : files.length === 0 ? (
            <EmptyRow label="No files yet." />
          ) : (
            <ScrollArea className="max-h-[500px] -mx-2 px-2">
              <Accordion type="multiple" defaultValue={["root"]}>
                <AccordionItem value="root">
                  <AccordionTrigger>
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <FileCode2 className="size-4 text-muted-foreground" />
                      repository root
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <FileTree
                      files={files}
                      onOpen={(f) => setOpenFile(f)}
                    />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Pull requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <GitPullRequest className="size-4" />
            Pull requests
          </CardTitle>
          <CardDescription>{prs.length} PR(s).</CardDescription>
        </CardHeader>
        <CardContent>
          {repoQ.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : prs.length === 0 ? (
            <EmptyRow label="No pull requests." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">#</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Branch → base</TableHead>
                  <TableHead className="w-24">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prs.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">#{p.number}</TableCell>
                    <TableCell className="text-sm">{p.title}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.sourceBranch} → {p.targetBranch}
                    </TableCell>
                    <TableCell>
                      <PRStateBadge state={p.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* File viewer */}
      <Dialog open={!!openFile} onOpenChange={(o) => !o && setOpenFile(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm break-all">
              {openFile?.path}
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground pb-1">
            {openFile?.language && (
              <Badge variant="outline" className="text-[10px]">
                {openFile.language}
              </Badge>
            )}
            <span>{formatBytes(openFile?.bytes ?? 0)}</span>
            {openFile?.suspiciousPatterns && openFile.suspiciousPatterns.length > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <AlertTriangle className="size-3" />
                {openFile.suspiciousPatterns.length} suspicious pattern(s)
              </span>
            )}
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-auto whitespace-pre-wrap break-words">
              {openFile?.content || "// file is empty"}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Commit changed-files viewer */}
      <Dialog open={!!openCommit} onOpenChange={(o) => !o && setOpenCommit(null)}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {shortSha(openCommit?.sha)} · {openCommit?.branch}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{openCommit?.message}</p>
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-1">
              {(openCommit?.filesChanged ?? []).map((f: any, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md border p-2 text-xs"
                >
                  <span className="font-mono truncate">
                    {typeof f === "string" ? f : f.path}
                  </span>
                  {typeof f === "object" && f.status && (
                    <Badge variant="outline" className="text-[10px]">
                      {f.status}
                    </Badge>
                  )}
                </div>
              ))}
              {(!openCommit?.filesChanged || openCommit.filesChanged.length === 0) && (
                <p className="text-sm text-muted-foreground">No changed files recorded.</p>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FileTree({
  files,
  onOpen,
}: {
  files: RepoFile[];
  onOpen: (f: RepoFile) => void;
}) {
  // Sort files by path for a stable, readable tree.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <ul className="space-y-0.5">
      {sorted.map((f) => {
        const patterns = f.suspiciousPatterns ?? [];
        const hasHigh = patterns.some((p) =>
          SUSPICIOUS_PATTERNS.some(
            (sp) => sp.label === p && sp.severity === "high"
          )
        );
        return (
          <li key={f.id}>
            <button
              onClick={() => onOpen(f)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
            >
              <span className="flex items-center gap-2 min-w-0">
                <FileCode2 className="size-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs truncate">{f.path}</span>
                {f.language && (
                  <Badge variant="outline" className="text-[10px] py-0 shrink-0">
                    {f.language}
                  </Badge>
                )}
              </span>
              <span className="flex items-center gap-2 shrink-0">
                {patterns.length > 0 && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] py-0",
                      hasHigh
                        ? "text-destructive border-destructive/40"
                        : "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800"
                    )}
                  >
                    <AlertTriangle className="size-3" />
                    {patterns.length}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatBytes(f.bytes ?? 0)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PRStateBadge({ state }: { state: string }) {
  const s = (state || "").toUpperCase();
  const cls =
    s === "MERGED"
      ? "text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-300 dark:border-fuchsia-800"
      : s === "OPEN"
        ? "text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
        : "text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("text-[10px]", cls)}>
      {s}
    </Badge>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
