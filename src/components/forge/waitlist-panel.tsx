"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Copy,
  Loader2,
  Shield,
  ThumbsDown,
  ThumbsUp,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "./lib/api";
import { formatRelative } from "./lib/format";

interface WaitlistEntry {
  id: string;
  email: string;
  name?: string | null;
  status: string;
  requestedAt: string;
  reviewedAt?: string | null;
}

interface AdminStats {
  totalUsers: number;
  totalProjects: number;
  totalProviders: number;
  totalTasks: number;
  totalCommits: number;
  totalFiles: number;
  waitlist: { pending: number; approved: number; rejected: number };
}

const STATUS_TONE: Record<string, string> = {
  PENDING:
    "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400",
  APPROVED:
    "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400",
  REJECTED:
    "bg-rose-500/10 text-rose-700 border-rose-500/30 dark:text-rose-400",
};

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card/60 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tracking-tight">{value}</div>
    </div>
  );
}

export function WaitlistPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const statsQ = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => apiGet<AdminStats>("/api/admin/stats"),
    enabled: open,
    staleTime: 10_000,
  });

  const entriesQ = useQuery({
    queryKey: ["waitlist"],
    queryFn: () => apiGet<{ entries: WaitlistEntry[] }>("/api/waitlist"),
    enabled: open,
    staleTime: 5_000,
  });

  const [approveTarget, setApproveTarget] =
    React.useState<WaitlistEntry | null>(null);

  const rejectMut = useMutation({
    mutationFn: (entry: WaitlistEntry) =>
      apiPost<{ entry: WaitlistEntry }>(
        `/api/waitlist/${entry.id}/reject`
      ),
    onSuccess: (_data, entry) => {
      toast({ title: "Entry rejected", description: entry.email });
      qc.invalidateQueries({ queryKey: ["waitlist"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Failed to reject",
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const entries = entriesQ.data?.entries ?? [];
  const stats = statsQ.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="size-5" />
            Admin · Waitlist & Platform
          </DialogTitle>
          <DialogDescription>
            Approve or reject waitlist requests. Approved accounts are created
            instantly with a generated password that you must share out-of-band.
          </DialogDescription>
        </DialogHeader>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {stats ? (
            <>
              <StatCard
                label="Users"
                value={stats.totalUsers}
                icon={<Users className="size-3.5" />}
              />
              <StatCard label="Projects" value={stats.totalProjects} />
              <StatCard label="Pending" value={stats.waitlist.pending} />
              <StatCard label="Approved" value={stats.waitlist.approved} />
            </>
          ) : (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          )}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto rounded-lg border min-h-[200px] max-h-[55vh]">
          {entriesQ.isLoading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : entriesQ.isError ? (
            <Alert variant="destructive" className="m-3">
              <AlertTitle>Couldn't load waitlist</AlertTitle>
              <AlertDescription>
                {entriesQ.error instanceof Error
                  ? entriesQ.error.message
                  : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <Users className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No waitlist entries yet.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead className="hidden sm:table-cell">Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Requested
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">
                      {e.email}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-sm">
                      {e.name || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={STATUS_TONE[e.status] ?? ""}
                      >
                        {e.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                      {formatRelative(e.requestedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {e.status === "PENDING" ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setApproveTarget(e)}
                          >
                            <ThumbsUp className="size-3.5" />
                            <span className="hidden sm:inline">Approve</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              rejectMut.isPending &&
                              rejectMut.variables?.id === e.id
                            }
                            onClick={() => rejectMut.mutate(e)}
                          >
                            {rejectMut.isPending &&
                            rejectMut.variables?.id === e.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <ThumbsDown className="size-3.5" />
                            )}
                            <span className="hidden sm:inline">Reject</span>
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <ApproveDialog
          entry={approveTarget}
          onClose={() => setApproveTarget(null)}
          onApproved={(email, password) => {
            qc.invalidateQueries({ queryKey: ["waitlist"] });
            qc.invalidateQueries({ queryKey: ["admin-stats"] });
            toast({
              title: `Account created for ${email}`,
              description: password
                ? "Share this password out-of-band — it won't be shown again."
                : "Account was already linked to an existing user.",
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ApproveDialog({
  entry,
  onClose,
  onApproved,
}: {
  entry: WaitlistEntry | null;
  onClose: () => void;
  onApproved: (email: string, password: string | null) => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = React.useState("");
  const [result, setResult] = React.useState<{
    email: string;
    password: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (entry) {
      setPassword("");
      setResult(null);
    }
  }, [entry]);

  const approveMut = useMutation({
    mutationFn: ({ id, pwd }: { id: string; pwd?: string }) =>
      apiPost<{
        user: { id: string; email: string; name?: string };
        password: string | null;
      }>(`/api/waitlist/${id}/approve`, pwd ? { password: pwd } : {}),
    onSuccess: (data) => {
      setResult({ email: data.user.email, password: data.password });
      onApproved(data.user.email, data.password);
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Approval failed",
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const open = !!entry;
  const pwdTooShort = !!password && password.length < 8;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ThumbsUp className="size-5" />
            Approve {entry?.email}
          </DialogTitle>
          <DialogDescription>
            {result
              ? "Account created. Copy the password below — it will not be shown again."
              : "Leave the password blank to auto-generate a strong one, or set a custom password (min 8 chars)."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>Account created for {result.email}</AlertTitle>
              <AlertDescription>
                The user can now sign in with this email and the password
                below.
              </AlertDescription>
            </Alert>
            {result.password ? (
              <div className="space-y-1.5">
                <Label htmlFor="gen-pwd">Generated password</Label>
                <div className="flex gap-2">
                  <Input
                    id="gen-pwd"
                    readOnly
                    value={result.password}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard?.writeText(result.password || "");
                      toast({ title: "Password copied" });
                    }}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                An account with this email already existed — it has been linked
                to this waitlist entry, but no new password was generated.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pwd">Custom password (optional)</Label>
              <Input
                id="pwd"
                type="text"
                placeholder="Leave blank to auto-generate"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {pwdTooShort && (
                <p className="text-xs text-destructive">
                  Password must be at least 8 characters.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={approveMut.isPending || pwdTooShort}
                onClick={() =>
                  entry &&
                  approveMut.mutate({
                    id: entry.id,
                    pwd: password || undefined,
                  })
                }
              >
                {approveMut.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                Approve & create account
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
