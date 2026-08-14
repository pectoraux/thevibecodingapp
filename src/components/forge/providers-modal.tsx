"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  KeyRound,
  Plus,
  Trash2,
  Sparkles,
  ShieldCheck,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

import { apiDelete, apiGet, apiPost } from "./lib/api";
import { formatCost, formatTokens } from "./lib/format";
import type { LlmProvider } from "./lib/types";
import { MODEL_CAPABILITIES } from "@/lib/types";
import { useForgeStore } from "./lib/store";

const PROVIDER_KINDS = [
  { value: "zai", label: "Z.ai (in-process sandbox)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "xai", label: "xAI (Grok)" },
  { value: "local", label: "Local (Ollama / vLLM)" },
];

interface ProviderFormState {
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  contextWindow: string;
  pricingPer1kInput: string;
  pricingPer1kOutput: string;
  isDefault: boolean;
  capabilities: string[];
}

const EMPTY_FORM: ProviderFormState = {
  name: "",
  provider: "zai",
  model: "",
  apiKey: "",
  contextWindow: "",
  pricingPer1kInput: "",
  pricingPer1kOutput: "",
  isDefault: false,
  capabilities: ["coding", "reasoning"],
};

export function ProvidersModal() {
  const open = useForgeStore((s) => s.providersModalOpen);
  const setOpen = useForgeStore((s) => s.setProvidersModalOpen);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: LlmProvider[] }>("/api/providers"),
    enabled: open,
    staleTime: 10_000,
  });

  const providers = data?.providers ?? [];

  const [showForm, setShowForm] = React.useState(false);
  const [form, setForm] = React.useState<ProviderFormState>(EMPTY_FORM);
  const [pendingDelete, setPendingDelete] = React.useState<LlmProvider | null>(null);

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<{ provider: LlmProvider }>("/api/providers", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast({ title: "Provider added", description: "Credentials stored encrypted (AES-256-GCM)." });
      setForm(EMPTY_FORM);
      setShowForm(false);
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Failed to add provider",
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/providers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast({ title: "Provider removed" });
      setPendingDelete(null);
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Failed to remove provider",
        description: err instanceof Error ? err.message : undefined,
      });
    },
  });

  const isZai = form.provider === "zai";

  function toggleCapability(cap: string) {
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(cap)
        ? f.capabilities.filter((c) => c !== cap)
        : [...f.capabilities, cap],
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.model.trim()) {
      toast({ variant: "destructive", title: "Name and model are required" });
      return;
    }
    if (!isZai && !form.apiKey.trim()) {
      toast({
        variant: "destructive",
        title: "API key required",
        description: "Non-sandbox providers require a valid API key.",
      });
      return;
    }
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      provider: form.provider,
      model: form.model.trim(),
      capabilities: form.capabilities,
      isDefault: form.isDefault,
    };
    if (!isZai) body.apiKey = form.apiKey;
    if (form.contextWindow) body.contextWindow = Number(form.contextWindow);
    if (form.pricingPer1kInput) body.pricingPer1kInput = Number(form.pricingPer1kInput);
    if (form.pricingPer1kOutput) body.pricingPer1kOutput = Number(form.pricingPer1kOutput);
    createMut.mutate(body);
  }

  const totalTokens = providers.reduce((acc, p) => acc + (p.contextWindow ?? 0), 0);
  const totalCost = providers.length; // cost aggregation not in API; show count as proxy

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            LLM Providers (BYOK)
          </DialogTitle>
          <DialogDescription>
            Bring your own model. Keys are encrypted at rest and never exposed
            to the UI or sent to other LLMs.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={showForm ? "ghost" : "default"}
            onClick={() => setShowForm((v) => !v)}
          >
            <Plus className="size-4" />
            {showForm ? "Cancel" : "Add Provider"}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {providers.length} configured · {formatTokens(totalTokens)} context
          </span>
        </div>

        {showForm && (
          <form
            onSubmit={handleSubmit}
            className="rounded-lg border p-4 space-y-4 bg-muted/30"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="prov-name">Name</Label>
                <Input
                  id="prov-name"
                  placeholder="e.g. GPT-4o prod"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prov-provider">Provider</Label>
                <Select
                  value={form.provider}
                  onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}
                >
                  <SelectTrigger id="prov-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_KINDS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prov-model">Model</Label>
                <Input
                  id="prov-model"
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prov-key">API Key {isZai && "(not required)"}</Label>
                <Input
                  id="prov-key"
                  type="password"
                  placeholder={isZai ? "Sandbox — no key needed" : "sk-…"}
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  disabled={isZai}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prov-ctx">Context window (tokens)</Label>
                <Input
                  id="prov-ctx"
                  type="number"
                  placeholder="128000"
                  value={form.contextWindow}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, contextWindow: e.target.value }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="prov-in">$/1k in</Label>
                  <Input
                    id="prov-in"
                    type="number"
                    step="0.0001"
                    placeholder="0.005"
                    value={form.pricingPer1kInput}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, pricingPer1kInput: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prov-out">$/1k out</Label>
                  <Input
                    id="prov-out"
                    type="number"
                    step="0.0001"
                    placeholder="0.015"
                    value={form.pricingPer1kOutput}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, pricingPer1kOutput: e.target.value }))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Capabilities</Label>
              <div className="flex flex-wrap gap-2">
                {MODEL_CAPABILITIES.map((cap) => (
                  <label
                    key={cap}
                    className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer hover:bg-accent"
                  >
                    <Checkbox
                      checked={form.capabilities.includes(cap)}
                      onCheckedChange={() => toggleCapability(cap)}
                    />
                    <span>{cap}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.isDefault}
                onCheckedChange={(v) =>
                  setForm((f) => ({ ...f, isDefault: v === true }))
                }
              />
              Set as default provider for unassigned agents
            </label>

            {isZai && (
              <Alert>
                <Sparkles className="size-4" />
                <AlertTitle>Sandbox LLM</AlertTitle>
                <AlertDescription>
                  The <code>zai</code> provider uses the in-process sandbox LLM
                  (z-ai-web-dev-sdk). No API key is required — great for local
                  development and cost-free runs.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                Save provider
              </Button>
            </div>
          </form>
        )}

        <Separator />

        <ScrollArea className="flex-1 min-h-0 max-h-[40vh] pr-3 -mr-3">
          <div className="space-y-2 pr-1">
            {isLoading && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            )}
            {isError && (
              <Alert variant="destructive">
                <AlertTitle>Couldn’t load providers</AlertTitle>
                <AlertDescription>
                  {error instanceof Error ? error.message : "Unknown error"}
                </AlertDescription>
              </Alert>
            )}
            {!isLoading && !isError && providers.length === 0 && (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                <Cpu className="mx-auto mb-2 size-6 opacity-50" />
                No providers configured yet. Add one above — or rely on the
                default <code>zai</code> sandbox.
              </div>
            )}
            {providers.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{p.name}</span>
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {p.provider}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {p.model}
                    </Badge>
                    {p.isDefault && (
                      <Badge className="bg-emerald-500 text-white border-transparent">
                        default
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(p.capabilities ?? []).map((c) => (
                      <Badge key={c} variant="outline" className="text-[10px] py-0">
                        {c}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    ctx {formatTokens(p.contextWindow ?? 0)} · in{" "}
                    {formatCost(p.pricingPer1kInput ?? 0)} · out{" "}
                    {formatCost(p.pricingPer1kOutput ?? 0)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => setPendingDelete(p)}
                >
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" />
            Secrets are encrypted at rest (AES-256-GCM) and never sent to LLMs as plaintext.
            {totalCost > 0 && ` ${totalCost} provider(s) registered.`}
          </p>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Delete confirmation */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove provider?</DialogTitle>
            <DialogDescription>
              This will delete <strong>{pendingDelete?.name}</strong> ({pendingDelete?.model}
              ). Agents currently assigned to it will fall back to the default.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => pendingDelete && deleteMut.mutate(pendingDelete.id)}
            >
              {deleteMut.isPending && <Loader2 className="size-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
