"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Braces,
  ChevronDown,
  FileCode2,
  Loader2,
  Lock,
  ScrollText,
  Snowflake,
  Sparkles,
  Wrench,
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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "../lib/api";
import { cn } from "@/lib/utils";
import type {
  Architecture,
  ArchitectureChangeRequest,
  Adr,
} from "../lib/types";

export function ArchitectureTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const archQ = useQuery({
    queryKey: ["architecture", projectId],
    queryFn: () =>
      apiGet<{ architecture: Architecture | null }>(
        `/api/projects/${projectId}/architecture`
      ),
  });
  const adrsQ = useQuery({
    queryKey: ["adrs", projectId],
    queryFn: () => apiGet<{ adrs: Adr[] }>(`/api/projects/${projectId}/adrs`),
  });
  const changesQ = useQuery({
    queryKey: ["arch-changes", projectId],
    queryFn: () =>
      apiGet<{ changeRequests: ArchitectureChangeRequest[] }>(
        `/api/projects/${projectId}/architecture/changes`
      ),
  });

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      apiGet<{ project: { status: string }; counts: any }>(
        `/api/projects/${projectId}`
      ),
  });
  const projectStatus = projectQ.data?.project?.status;
  const isFrozen = archQ.data?.architecture?.frozen;

  const [generating, setGenerating] = React.useState(false);
  const [contractOpen, setContractOpen] = React.useState(false);
  const [freezeOpen, setFreezeOpen] = React.useState(false);

  const generateMut = useMutation({
    mutationFn: () =>
      apiPost<{ architecture: Architecture }>(
        `/api/projects/${projectId}/architecture/generate`
      ),
    onMutate: () => setGenerating(true),
    onSuccess: () => {
      toast({ title: "Architecture generated", description: "Review and freeze it." });
      qc.invalidateQueries({ queryKey: ["architecture", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Architecture generation failed",
        description: err instanceof Error ? err.message : undefined,
      }),
    onSettled: () => setGenerating(false),
  });

  const freezeMut = useMutation({
    mutationFn: () =>
      apiPost<{ architecture: Architecture }>(
        `/api/projects/${projectId}/architecture/freeze`
      ),
    onSuccess: () => {
      toast({ title: "Architecture frozen", description: "You can now start a build." });
      setFreezeOpen(false);
      qc.invalidateQueries({ queryKey: ["architecture", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Failed to freeze",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const arch = archQ.data?.architecture;

  if (archQ.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!arch) {
    return (
      <>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="rounded-full bg-muted p-3">
              <Sparkles className="size-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No architecture yet</p>
              <p className="text-sm text-muted-foreground max-w-md">
                The Architect agent will read your product spec and design
                components, data models, API contracts, and invariants. Takes
                ~10–30 seconds.
              </p>
            </div>
            <Button
              onClick={() => generateMut.mutate()}
              disabled={generating}
            >
              {generating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Generate Architecture
            </Button>
          </CardContent>
        </Card>
        <LongRunOverlay
          open={generating}
          title="Architect is designing your system…"
          description="The Architect agent reads your spec and produces a complete architecture: components, data models, API contracts, invariants, and ADRs. This may take up to 30 seconds."
        />
      </>
    );
  }

  const components = arch.components ?? [];
  const dataModels = arch.dataModels ?? [];
  const apiContracts = arch.apiContracts ?? [];
  const integrations = arch.integrations ?? [];
  const invariants = arch.invariants ?? [];
  const constraints = arch.constraints ?? [];

  return (
    <div className="space-y-4">
      {/* Header card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Boxes className="size-4" />
                Architecture
                <Badge variant="outline" className="font-mono">
                  v{arch.version}
                </Badge>
                {isFrozen ? (
                  <Badge className="bg-cyan-500 text-white border-transparent gap-1">
                    <Snowflake className="size-3" />
                    frozen
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800">
                    <Lock className="size-3" />
                    draft
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="font-mono text-xs">
                hash {arch.hash?.slice(0, 12) ?? "—"}
                {arch.frozenAt && ` · frozen ${new Date(arch.frozenAt).toLocaleString()}`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setContractOpen(true)}>
                <Braces className="size-4" />
                View JSON
              </Button>
              {!isFrozen && (
                <Button size="sm" onClick={() => setFreezeOpen(true)}>
                  <Snowflake className="size-4" />
                  Freeze
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Components */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Components</CardTitle>
          <CardDescription>
            {components.length} component{components.length === 1 ? "" : "s"} in
            the system design.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {components.length === 0 ? (
            <EmptyRow label="No components defined." />
          ) : (
            <Accordion type="multiple" className="w-full">
              {components.map((c: any, i: number) => (
                <AccordionItem key={c.name ?? i} value={c.name ?? String(i)}>
                  <AccordionTrigger>
                    <div className="flex items-center gap-2 flex-wrap pr-2">
                      <FileCode2 className="size-4 text-muted-foreground" />
                      <span className="font-medium">{c.name}</span>
                      {c.type && (
                        <Badge variant="outline" className="text-[10px]">
                          {c.type}
                        </Badge>
                      )}
                      {c.tech && (
                        <Badge variant="secondary" className="text-[10px] font-mono">
                          {Array.isArray(c.tech) ? c.tech.join(", ") : c.tech}
                        </Badge>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-2">
                    {c.responsibilities && (
                      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                        {(Array.isArray(c.responsibilities)
                          ? c.responsibilities
                          : [c.responsibilities]
                        ).map((r: any, idx: number) => (
                          <li key={idx}>{String(r)}</li>
                        ))}
                      </ul>
                    )}
                    {c.description && (
                      <p className="text-sm text-muted-foreground">{c.description}</p>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

      {/* Data models */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data models</CardTitle>
          <CardDescription>Entity schemas designed by the Architect.</CardDescription>
        </CardHeader>
        <CardContent>
          {dataModels.length === 0 ? (
            <EmptyRow label="No data models." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Fields</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dataModels.map((m: any, i: number) => (
                  <TableRow key={m.name ?? i}>
                    <TableCell className="font-mono text-xs">{m.name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {Array.isArray(m.fields)
                        ? m.fields
                            .map((f: any) =>
                              typeof f === "string"
                                ? f
                                : `${f.name}:${f.type ?? "any"}`
                            )
                            .join(", ")
                        : JSON.stringify(m.fields)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* API contracts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">API contracts</CardTitle>
          <CardDescription>Endpoints the system exposes.</CardDescription>
        </CardHeader>
        <CardContent>
          {apiContracts.length === 0 ? (
            <EmptyRow label="No API contracts." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-24">Auth</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiContracts.map((c: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {c.method ?? "GET"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.path ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {c.auth ?? "none"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.description ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Integrations + invariants + constraints */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Integrations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {integrations.length === 0 ? (
              <EmptyRow label="No integrations." />
            ) : (
              integrations.map((it: any, i: number) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <span className="font-medium">
                    {typeof it === "string" ? it : it.name ?? `Integration ${i + 1}`}
                  </span>
                  {typeof it === "object" && it.purpose && (
                    <span className="text-xs text-muted-foreground">{it.purpose}</span>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Invariants
              <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800">
                Guardian-enforced
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invariants.length === 0 ? (
              <EmptyRow label="No invariants declared." />
            ) : (
              <ul className="space-y-1.5 text-sm">
                {invariants.map((inv, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-amber-500">▸</span>
                    <span className="text-muted-foreground">{inv}</span>
                  </li>
                ))}
              </ul>
            )}
            {constraints.length > 0 && (
              <>
                <div className="text-xs font-medium uppercase text-muted-foreground pt-2">
                  Constraints
                </div>
                <ul className="space-y-1.5 text-sm">
                  {constraints.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-muted-foreground">•</span>
                      <span className="text-muted-foreground">{c}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ADRs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="size-4" />
            Architecture Decision Records
          </CardTitle>
          <CardDescription>
            {adrsQ.data?.adrs?.length ?? 0} ADR(s) recorded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {adrsQ.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (adrsQ.data?.adrs ?? []).length === 0 ? (
            <EmptyRow label="No ADRs yet." />
          ) : (
            <Accordion type="multiple" className="w-full">
              {(adrsQ.data?.adrs ?? []).map((a) => (
                <AccordionItem key={a.id} value={a.id}>
                  <AccordionTrigger>
                    <div className="flex items-center gap-2 pr-2">
                      <span className="font-medium">{a.title}</span>
                      {a.status && (
                        <Badge variant="outline" className="text-[10px]">
                          {a.status}
                        </Badge>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-2 text-sm text-muted-foreground">
                    {a.context && (
                      <div>
                        <span className="font-medium text-foreground">Context: </span>
                        {a.context}
                      </div>
                    )}
                    {a.decision && (
                      <div>
                        <span className="font-medium text-foreground">Decision: </span>
                        {a.decision}
                      </div>
                    )}
                    {a.consequences && (
                      <div>
                        <span className="font-medium text-foreground">Consequences: </span>
                        {a.consequences}
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

      {/* Change requests */}
      <ChangeRequestSection projectId={projectId} existing={(changesQ.data?.changeRequests ?? [])} />

      {/* Freeze dialog */}
      <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Freeze architecture?</DialogTitle>
            <CardDescription>
              Freezing locks the design. The Guardian will reject any
              implementation that drifts. You can still file a change request
              afterwards.
            </CardDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setFreezeOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => freezeMut.mutate()} disabled={freezeMut.isPending}>
              {freezeMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Snowflake className="size-4" />
              )}
              Freeze architecture
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Contract JSON */}
      <Dialog open={contractOpen} onOpenChange={setContractOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Architecture contract (JSON)</DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            <pre className="rounded-md bg-muted p-4 text-xs font-mono overflow-auto">
              {JSON.stringify(arch.contractJson ?? arch, null, 2)}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <LongRunOverlay
        open={generating}
        title="Architect is designing your system…"
        description="The Architect agent reads your spec and produces a complete architecture: components, data models, API contracts, invariants, and ADRs. This may take up to 30 seconds."
      />
    </div>
  );
}

function ChangeRequestSection({
  projectId,
  existing,
}: {
  projectId: string;
  existing: ArchitectureChangeRequest[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    title: "",
    problem: "",
    proposedChange: "",
    rationale: "",
  });

  const mut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<{ changeRequest: ArchitectureChangeRequest }>(
        `/api/projects/${projectId}/architecture/changes`,
        body
      ),
    onSuccess: () => {
      toast({ title: "Change request filed" });
      setForm({ title: "", problem: "", proposedChange: "", rationale: "" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["arch-changes", projectId] });
    },
    onError: (err: unknown) =>
      toast({
        variant: "destructive",
        title: "Failed to file change request",
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="size-4" />
              Architecture change requests
            </CardTitle>
            <CardDescription>{existing.length} filed.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "File change request"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {open && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.title.trim()) {
                toast({ variant: "destructive", title: "Title is required" });
                return;
              }
              mut.mutate({
                title: form.title.trim(),
                problem: form.problem.trim(),
                proposedChange: form.proposedChange.trim(),
                rationale: form.rationale.trim(),
              });
            }}
            className="rounded-lg border p-3 space-y-3 bg-muted/30"
          >
            <div className="space-y-1.5">
              <Label htmlFor="cr-title">Title</Label>
              <Input
                id="cr-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-problem">Problem</Label>
              <Textarea
                id="cr-problem"
                value={form.problem}
                onChange={(e) => setForm((f) => ({ ...f, problem: e.target.value }))}
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cr-change">Proposed change</Label>
                <Textarea
                  id="cr-change"
                  value={form.proposedChange}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, proposedChange: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cr-rat">Rationale</Label>
                <Textarea
                  id="cr-rat"
                  value={form.rationale}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, rationale: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={mut.isPending}>
                {mut.isPending && <Loader2 className="size-4 animate-spin" />}
                Submit
              </Button>
            </div>
          </form>
        )}

        {existing.length === 0 ? (
          <EmptyRow label="No change requests filed." />
        ) : (
          <div className="space-y-2">
            {existing.map((c) => (
              <Collapsible key={c.id} className="rounded-md border p-3">
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left">
                  <span className="font-medium text-sm">{c.title}</span>
                  <div className="flex items-center gap-2">
                    {c.status && (
                      <Badge variant="outline" className="text-[10px]">
                        {c.status}
                      </Badge>
                    )}
                    <ChevronDown className="size-4 text-muted-foreground" />
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 text-sm text-muted-foreground space-y-1">
                  {c.problem && (
                    <p>
                      <span className="font-medium text-foreground">Problem:</span>{" "}
                      {c.problem}
                    </p>
                  )}
                  {c.proposedChange && (
                    <p>
                      <span className="font-medium text-foreground">Proposed:</span>{" "}
                      {c.proposedChange}
                    </p>
                  )}
                  {c.rationale && (
                    <p>
                      <span className="font-medium text-foreground">Rationale:</span>{" "}
                      {c.rationale}
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function LongRunOverlay({
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
            <CardDescription className="max-w-sm">{description}</CardDescription>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
