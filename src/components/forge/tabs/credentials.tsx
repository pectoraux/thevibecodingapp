"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Rocket,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPatch, apiPost } from "../lib/api";
import { cn } from "@/lib/utils";
import type { Credential, PreflightResult } from "../lib/types";

const ENV_OPTIONS = ["production", "test", "sandbox", "development"];

export function CredentialsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState<Credential | null>(null);
  const [preflight, setPreflight] = React.useState<PreflightResult | null>(null);

  const q = useQuery({
    queryKey: ["credentials", projectId],
    queryFn: () =>
      apiGet<{ credentials: Credential[] }>(
        `/api/projects/${projectId}/credentials`
      ),
    staleTime: 10_000,
  });

  const preflightMut = useMutation({
    mutationFn: () => apiPost<{ preflight: PreflightResult }>(`/api/projects/${projectId}/preflight`),
    onSuccess: (res) => {
      setPreflight(res.preflight);
      toast({
        title: res.preflight.passed ? "Preflight passed" : "Preflight failed",
        description: `${res.preflight.configured}/${res.preflight.total} credentials configured.`,
        variant: res.preflight.passed ? "default" : "destructive",
      });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Preflight failed",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const creds = q.data?.credentials ?? [];

  return (
    <div className="space-y-4">
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Secret handling</AlertTitle>
        <AlertDescription>
          Secrets are encrypted at rest (AES-256-GCM) and never sent to LLMs as plaintext.
          The UI never displays secret values — only whether each is configured
          and validated.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <KeyRound className="size-4" />
                Required credentials
              </CardTitle>
              <CardDescription>
                {creds.length} credential(s) declared by the architecture.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => preflightMut.mutate()}
              disabled={preflightMut.isPending}
            >
              {preflightMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rocket className="size-4" />
              )}
              Run Preflight
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : creds.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No credentials required for this project yet. Generate an
              architecture first.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Purpose</TableHead>
                    <TableHead className="hidden lg:table-cell">Provider</TableHead>
                    <TableHead className="w-28">Env</TableHead>
                    <TableHead className="w-20">Required</TableHead>
                    <TableHead className="w-24">Configured</TableHead>
                    <TableHead className="w-24 hidden sm:table-cell">Validated</TableHead>
                    <TableHead className="w-24 hidden xl:table-cell">Sandbox</TableHead>
                    <TableHead className="w-24 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {creds.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.name}</TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-[200px] truncate">
                        {c.purpose ?? "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {c.provider && (
                          <Badge variant="outline" className="text-[10px]">
                            {c.provider}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.environment ?? "—"}
                      </TableCell>
                      <TableCell>
                        {c.required ? (
                          <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800">
                            required
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            optional
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <BoolBadge ok={!!c.configured} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <BoolBadge ok={!!c.validated} />
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <BoolBadge ok={!!c.testSandboxSupport} neutral />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                          {c.configured ? "Update" : "Set value"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preflight result */}
      {preflight && (
        <Card
          className={cn(
            preflight.passed
              ? "border-emerald-300 dark:border-emerald-800"
              : "border-destructive/40"
          )}
        >
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {preflight.passed ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : (
                <XCircle className="size-4 text-destructive" />
              )}
              Preflight result
            </CardTitle>
            <CardDescription>
              {preflight.configured}/{preflight.total} credentials configured.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {preflight.missing && preflight.missing.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  Missing
                </p>
                {preflight.missing.map((m, i) => (
                  <div key={i} className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
                    <span className="font-mono text-xs">{m.name}</span>
                    {m.purpose && (
                      <p className="text-xs text-muted-foreground">{m.purpose}</p>
                    )}
                    {m.whenRequired && (
                      <p className="text-xs text-muted-foreground">
                        When: {m.whenRequired}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                All required credentials are configured.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <SetCredentialDialog
        credential={editing}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        projectId={projectId}
      />
    </div>
  );
}

function BoolBadge({ ok, neutral }: { ok: boolean; neutral?: boolean }) {
  if (neutral) {
    return ok ? (
      <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800">
        yes
      </Badge>
    ) : (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        no
      </Badge>
    );
  }
  return ok ? (
    <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800">
      <CheckCircle2 className="size-3" />
      yes
    </Badge>
  ) : (
    <Badge variant="outline" className="text-[10px] text-destructive border-destructive/40">
      <XCircle className="size-3" />
      no
    </Badge>
  );
}

function SetCredentialDialog({
  credential,
  open,
  onOpenChange,
  projectId,
}: {
  credential: Credential | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [value, setValue] = React.useState("");
  const [env, setEnv] = React.useState("production");

  React.useEffect(() => {
    if (credential) {
      setValue("");
      setEnv(credential.environment ?? "production");
    }
  }, [credential]);

  const mut = useMutation({
    mutationFn: () =>
      apiPatch<{ credential: Credential }>(
        `/api/projects/${projectId}/credentials/${credential?.id}`,
        { value, environment: env }
      ),
    onSuccess: () => {
      toast({ title: "Credential saved", description: "Stored encrypted, validated." });
      qc.invalidateQueries({ queryKey: ["credentials", projectId] });
      onOpenChange(false);
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Failed to save credential",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            {credential?.configured ? "Update" : "Set"} credential
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{credential?.name}</span>
            {credential?.purpose ? ` — ${credential.purpose}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cred-value">Value</Label>
            <Input
              id="cred-value"
              type="password"
              placeholder="paste secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
            />
            {credential?.configured && (
              <p className="text-xs text-muted-foreground">
                Already configured. Enter a new value to overwrite (the previous
                value is never shown).
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-env">Environment</Label>
            <Select value={env} onValueChange={setEnv}>
              <SelectTrigger id="cred-env" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENV_OPTIONS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={mut.isPending || !value.trim()}
            onClick={() => mut.mutate()}
          >
            {mut.isPending && <Loader2 className="size-4 animate-spin" />}
            Save (encrypted)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
