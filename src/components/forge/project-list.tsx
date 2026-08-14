"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Boxes,
  Github,
  Loader2,
  Plus,
  Rocket,
  Search,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "./lib/api";
import { formatRelative } from "./lib/format";
import type { Project } from "./lib/types";
import { useForgeStore } from "./lib/store";
import { ProjectStatusBadge } from "./status-badge";

export function ProjectList() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const setSelected = useForgeStore((s) => s.setSelectedProjectId);
  const setProvidersOpen = useForgeStore((s) => s.setProvidersModalOpen);

  const [query, setQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<{ projects: Project[] }>("/api/projects"),
    staleTime: 5_000,
  });

  const projects = data?.projects ?? [];
  const filtered = query.trim()
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          (p.description ?? "").toLowerCase().includes(query.toLowerCase())
      )
    : projects;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <Wrench className="size-7 text-foreground" />
            Forge
          </h1>
          <p className="text-sm text-muted-foreground">
            Autonomous multi-agent software factory. Spin up a project, freeze
            an architecture, and let agents build it end-to-end.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setProvidersOpen(true)}>
            <Boxes className="size-4" />
            <span className="hidden sm:inline">LLM Providers</span>
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New Project
          </Button>
        </div>
      </header>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder="Search projects…"
          className="pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn’t load projects</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : "Unknown error"}
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="rounded-full bg-muted p-3">
              <Rocket className="size-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No projects yet</p>
              <p className="text-sm text-muted-foreground">
                Create your first project to get the architect designing.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create project
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((p, i) => (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.2) }}
          >
            <ProjectCard project={p} onOpen={() => setSelected(p.id)} />
          </motion.div>
        ))}
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(p) => {
          qc.invalidateQueries({ queryKey: ["projects"] });
          toast({ title: "Project created", description: p.name });
          setSelected(p.id);
        }}
      />
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}) {
  const tasks = project._count?.tasks ?? 0;
  return (
    <Card className="h-full transition-shadow hover:shadow-md cursor-pointer group" onClick={onOpen}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate group-hover:text-primary transition-colors">
              {project.name}
            </CardTitle>
            <CardDescription className="line-clamp-2 min-h-[2.5rem]">
              {project.description || "No description provided."}
            </CardDescription>
          </div>
          <ProjectStatusBadge status={project.status} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {project.githubConnected ? (
            <Badge variant="outline" className="gap-1">
              <Github className="size-3" />
              {project.githubRepo || "repo connected"}
            </Badge>
          ) : (
            <Badge variant="outline" className="opacity-60">
              no repo
            </Badge>
          )}
          <Badge variant="outline">{tasks} task{tasks === 1 ? "" : "s"}</Badge>
          <span>· updated {formatRelative(project.updatedAt ?? project.createdAt)}</span>
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button size="sm" variant="ghost">
          Open
        </Button>
      </CardFooter>
    </Card>
  );
}

interface CreateForm {
  name: string;
  description: string;
  productSpec: string;
  requirements: string;
  stack: string;
}

const EMPTY: CreateForm = {
  name: "",
  description: "",
  productSpec: "",
  requirements: "",
  stack: "Next.js, PostgreSQL, Stripe",
};

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (p: Project) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = React.useState<CreateForm>(EMPTY);

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<{ project: Project }>("/api/projects", body),
    onSuccess: (res) => {
      onCreated(res.project);
      setForm(EMPTY);
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Failed to create project",
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    if (!form.productSpec.trim()) {
      toast({
        variant: "destructive",
        title: "Product spec is required",
        description: "Describe what the agents should build.",
      });
      return;
    }
    createMut.mutate({
      name: form.name.trim(),
      description: form.description.trim(),
      productSpec: form.productSpec.trim(),
      requirements: form.requirements.trim(),
      stack: form.stack.trim(),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setForm(EMPTY); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="size-5" />
            New Forge Project
          </DialogTitle>
          <DialogDescription>
            Describe the product. The Architect agent will turn this into a
            frozen system design before any code is written.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto space-y-4 pr-1"
        >
          <div className="space-y-1.5">
            <Label htmlFor="p-name">Name *</Label>
            <Input
              id="p-name"
              placeholder="e.g. Acme Subscriptions"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-desc">Short description</Label>
            <Input
              id="p-desc"
              placeholder="One-line summary"
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-spec">Product spec *</Label>
            <Textarea
              id="p-spec"
              className="min-h-[140px]"
              placeholder="Describe the product: target users, key features, user flows, success criteria. Be specific — this drives architecture."
              value={form.productSpec}
              onChange={(e) =>
                setForm((f) => ({ ...f, productSpec: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-req">Requirements</Label>
            <Textarea
              id="p-req"
              className="min-h-[80px]"
              placeholder="Non-functional requirements, constraints, compliance, scale targets (one per line)."
              value={form.requirements}
              onChange={(e) =>
                setForm((f) => ({ ...f, requirements: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-stack">Tech stack</Label>
            <Input
              id="p-stack"
              placeholder="Next.js, PostgreSQL, Stripe"
              value={form.stack}
              onChange={(e) => setForm((f) => ({ ...f, stack: e.target.value }))}
            />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Create & initialize repo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
