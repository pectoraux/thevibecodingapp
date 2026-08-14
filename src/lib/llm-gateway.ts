// Forge — Real LLM Gateway.
//
// Replaces the old ZaiAdapter-with-TemplateAdapter-fallback in src/lib/llm.ts.
//
// Design principles (per AUDIT.md item #3):
// - NO TemplateAdapter fallback in production. LLM unavailable -> BLOCKED.
//   The TemplateAdapter is only usable when explicitly enabled via
//   FORGE_ALLOW_TEMPLATE=true AND NODE_ENV !== 'production'.
// - Each provider adapter makes real HTTP (or SDK) calls and reports real
//   token usage, latency, and error classification.
// - The gateway applies an ExecutionPolicy (retry, timeout) on top of each
//   provider's complete() call. Every execution is recorded as an
//   LlmExecution; the orchestrator persists it.
// - On Vercel without BYOK and without z-ai, the platform is BLOCKED, not fake.
//
// Backward compatibility:
// - This module also exports the legacy types (ChatMessage, CompletionResult,
//   LlmAdapter) and a buildAdapter() factory that wraps an LLMProvider into
//   the legacy LlmAdapter interface. Existing callers (orchestrator.ts,
//   template-adapter.ts) keep working without code changes.

import type { AgentType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Lifecycle status of a single LLM execution attempt.
 * - BLOCKED: no usable provider available (no BYOK + z-ai unavailable).
 * - QUEUED / RUNNING: lifecycle markers (the gateway runs synchronously, but
 *   the orchestrator may persist these states).
 * - SUCCEEDED: the provider returned valid content.
 * - FAILED: generic provider failure not covered by a more specific status.
 * - TIMEOUT: AbortController fired before completion.
 * - RATE_LIMITED: HTTP 429.
 * - AUTH_FAILED: HTTP 401/403.
 * - INVALID_RESPONSE: provider returned non-JSON or malformed body.
 * - CANCELLED: caller aborted via signal.
 */
export type ExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "INVALID_RESPONSE"
  | "CANCELLED"
  | "BLOCKED";

/**
 * Evidence record for a single LLM call. The orchestrator persists this as
 * an AgentExecution row.
 */
export interface LlmExecution {
  provider: string;
  model: string;
  agent: string;
  promptVersion: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  latency: number;
  attempt: number;
  status: ExecutionStatus;
  error: string | null;
  content: string;
}

export interface ProviderCompleteOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * A real LLM provider adapter. Implementations make actual HTTP/SDK calls
 * and report token usage + classified status.
 */
export interface LLMProvider {
  kind: string; // 'openai' | 'anthropic' | 'google' | 'xai' | 'zai' | 'openai-compat' | 'ollama'
  model: string;
  complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution>;
}

// ---------------------------------------------------------------------------
// Legacy types (kept for backward compatibility with orchestrator.ts and
// template-adapter.ts). The legacy LlmAdapter returns CompletionResult.
// ---------------------------------------------------------------------------

export interface CompletionResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface LlmAdapter {
  kind: string;
  model: string;
  complete(messages: ChatMessage[]): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowDate(): Date {
  return new Date();
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token. Used only when the provider response
  // omits usage info (e.g. some OpenAI-compatible servers).
  return Math.ceil((text || "").length / 4);
}

function buildExecution(args: {
  provider: string;
  model: string;
  agent: string;
  startedAt: Date;
  completedAt?: Date | null;
  inputTokens?: number;
  outputTokens?: number;
  attempt?: number;
  status: ExecutionStatus;
  error?: string | null;
  content?: string;
}): LlmExecution {
  const completedAt = args.completedAt ?? null;
  const latency = completedAt
    ? completedAt.getTime() - args.startedAt.getTime()
    : 0;
  return {
    provider: args.provider,
    model: args.model,
    agent: args.agent,
    promptVersion: "forge-v1",
    startedAt: args.startedAt,
    completedAt,
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    latency,
    attempt: args.attempt ?? 1,
    status: args.status,
    error: args.error ?? null,
    content: args.content ?? "",
  };
}

/**
 * Combine a caller-supplied AbortSignal with an internal timeout signal.
 * Whichever fires first aborts the underlying fetch.
 */
function linkSignals(
  timeoutMs: number | undefined,
  externalSignal?: AbortSignal
): { signal: AbortSignal | undefined; clear: () => void } {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  let aborted = false;

  const fire = (reason: string) => {
    if (aborted) return;
    aborted = true;
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  };

  if (timeoutMs && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => fire("timeout"), timeoutMs);
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      fire("external-abort");
    } else {
      externalSignal.addEventListener("abort", () => fire("external-abort"), {
        once: true,
      });
    }
  }

  const clear = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;
  };

  // If no timeout and no external signal, return undefined so the caller can
  // skip passing a signal (some SDKs treat `signal: undefined` differently).
  if (!timeoutMs && !externalSignal) {
    return { signal: undefined, clear };
  }
  return { signal: controller.signal, clear };
}

function classifyAbortError(err: unknown, externalSignal?: AbortSignal): ExecutionStatus {
  if (externalSignal?.aborted) return "CANCELLED";
  const msg = (err as any)?.message ?? String(err);
  if (/timeout/i.test(msg)) return "TIMEOUT";
  return "TIMEOUT";
}

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements LLMProvider {
  kind = "openai";
  constructor(
    public model: string,
    private apiKey: string,
    private baseUrl = "https://api.openai.com/v1",
    private agent: string = "unknown"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    const startedAt = nowDate();
    const { signal, clear } = linkSignals(opts?.timeout, opts?.signal);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.2,
        }),
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "AUTH_FAILED",
          error: `HTTP ${res.status}: authentication failed`,
        });
      }
      if (res.status === 429) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "RATE_LIMITED",
          error: "HTTP 429: rate limited",
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "FAILED",
          error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
        });
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "INVALID_RESPONSE",
          error: "Response was not valid JSON",
        });
      }
      const content = data?.choices?.[0]?.message?.content ?? "";
      if (!content) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          inputTokens: data?.usage?.prompt_tokens ?? estimateTokens(
            messages.map((m) => m.content).join("\n")
          ),
          outputTokens: 0,
          status: "INVALID_RESPONSE",
          error: "Empty content in provider response",
        });
      }
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        inputTokens: data?.usage?.prompt_tokens ?? estimateTokens(
          messages.map((m) => m.content).join("\n")
        ),
        outputTokens: data?.usage?.completion_tokens ?? estimateTokens(content),
        status: "SUCCEEDED",
        content,
      });
    } catch (err: any) {
      const status = (err?.name === "AbortError" || /abort/i.test(err?.message ?? ""))
        ? classifyAbortError(err, opts?.signal)
        : "FAILED";
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        status,
        error: err?.message ?? String(err),
      });
    } finally {
      clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements LLMProvider {
  kind = "anthropic";
  constructor(
    public model: string,
    private apiKey: string,
    private baseUrl = "https://api.anthropic.com/v1",
    private agent: string = "unknown",
    private anthropicVersion = "2023-06-01"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    const startedAt = nowDate();
    const { signal, clear } = linkSignals(opts?.timeout, opts?.signal);
    try {
      // Anthropic API separates system prompt from message list.
      const sysMsg = messages.find((m) => m.role === "system");
      const userMsgs = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.anthropicVersion,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: sysMsg?.content,
          messages: userMsgs,
        }),
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "AUTH_FAILED",
          error: `HTTP ${res.status}: authentication failed`,
        });
      }
      if (res.status === 429) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "RATE_LIMITED",
          error: "HTTP 429: rate limited",
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "FAILED",
          error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
        });
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "INVALID_RESPONSE",
          error: "Response was not valid JSON",
        });
      }
      // Anthropic content is an array of content blocks.
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const content = blocks
        .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
        .join("");
      if (!content) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          inputTokens: data?.usage?.input_tokens ?? estimateTokens(
            messages.map((m) => m.content).join("\n")
          ),
          outputTokens: 0,
          status: "INVALID_RESPONSE",
          error: "Empty content in provider response",
        });
      }
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        inputTokens: data?.usage?.input_tokens ?? estimateTokens(
          messages.map((m) => m.content).join("\n")
        ),
        outputTokens: data?.usage?.output_tokens ?? estimateTokens(content),
        status: "SUCCEEDED",
        content,
      });
    } catch (err: any) {
      const status = (err?.name === "AbortError" || /abort/i.test(err?.message ?? ""))
        ? classifyAbortError(err, opts?.signal)
        : "FAILED";
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        status,
        error: err?.message ?? String(err),
      });
    } finally {
      clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Google (Generative Language API) adapter
// ---------------------------------------------------------------------------

export class GoogleAdapter implements LLMProvider {
  kind = "google";
  constructor(
    public model: string,
    private apiKey: string,
    private baseUrl = "https://generativelanguage.googleapis.com/v1beta",
    private agent: string = "unknown"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    const startedAt = nowDate();
    const { signal, clear } = linkSignals(opts?.timeout, opts?.signal);
    try {
      // Google's generateContent expects contents[] with role/user|model.
      const sysMsg = messages.find((m) => m.role === "system");
      const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const url =
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent` +
        `?key=${encodeURIComponent(this.apiKey)}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(sysMsg ? { systemInstruction: { parts: [{ text: sysMsg.content }] } } : {}),
          contents,
          generationConfig: { temperature: 0.2 },
        }),
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "AUTH_FAILED",
          error: `HTTP ${res.status}: authentication failed`,
        });
      }
      if (res.status === 429) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "RATE_LIMITED",
          error: "HTTP 429: rate limited",
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "FAILED",
          error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
        });
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          status: "INVALID_RESPONSE",
          error: "Response was not valid JSON",
        });
      }
      const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
      const parts = candidates?.[0]?.content?.parts ?? [];
      const content = parts
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("");
      if (!content) {
        const blockReason = candidates?.[0]?.finishReason;
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          inputTokens: data?.usageMetadata?.promptTokenCount ?? estimateTokens(
            messages.map((m) => m.content).join("\n")
          ),
          outputTokens: 0,
          status: "INVALID_RESPONSE",
          error: `Empty content in provider response${blockReason ? ` (finishReason: ${blockReason})` : ""}`,
        });
      }
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        inputTokens:
          data?.usageMetadata?.promptTokenCount ?? estimateTokens(
            messages.map((m) => m.content).join("\n")
          ),
        outputTokens:
          data?.usageMetadata?.candidatesTokenCount ?? estimateTokens(content),
        status: "SUCCEEDED",
        content,
      });
    } catch (err: any) {
      const status = (err?.name === "AbortError" || /abort/i.test(err?.message ?? ""))
        ? classifyAbortError(err, opts?.signal)
        : "FAILED";
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        status,
        error: err?.message ?? String(err),
      });
    } finally {
      clear();
    }
  }
}

// ---------------------------------------------------------------------------
// xAI adapter (OpenAI-compatible at https://api.x.ai/v1)
// ---------------------------------------------------------------------------

export class XaiAdapter implements LLMProvider {
  kind = "xai";
  constructor(
    public model: string,
    private apiKey: string,
    private baseUrl = "https://api.x.ai/v1",
    private agent: string = "unknown"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    // xAI is OpenAI-compatible — delegate to OpenAIAdapter with the x.ai base.
    const inner = new OpenAIAdapter(this.model, this.apiKey, this.baseUrl, this.agent);
    inner.kind = "xai";
    return inner.complete(messages, opts);
  }
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible adapter (Ollama, local, custom endpoints)
// ---------------------------------------------------------------------------

export class OpenAICompatAdapter implements LLMProvider {
  kind = "openai-compat";
  constructor(
    public model: string,
    private apiKey: string,
    private baseUrl: string,
    private agent: string = "unknown"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    const inner = new OpenAIAdapter(this.model, this.apiKey, this.baseUrl, this.agent);
    inner.kind = "openai-compat";
    return inner.complete(messages, opts);
  }
}

// ---------------------------------------------------------------------------
// Ollama adapter (local, often no API key; uses OpenAI-compat endpoint)
// ---------------------------------------------------------------------------

export class OllamaAdapter implements LLMProvider {
  kind = "ollama";
  constructor(
    public model: string,
    private baseUrl = "http://localhost:11434/v1",
    private agent: string = "unknown"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    const inner = new OpenAIAdapter(this.model, "", this.baseUrl, this.agent);
    inner.kind = "ollama";
    return inner.complete(messages, opts);
  }
}

// ---------------------------------------------------------------------------
// z-ai adapter — uses z-ai-web-dev-sdk. Only works in the space-z.ai sandbox.
// If the SDK is unavailable or fails, this adapter returns FAILED. No fallback.
// ---------------------------------------------------------------------------

export class ZaiAdapter implements LLMProvider {
  kind = "zai";
  constructor(
    public model = "glm-4.6",
    private agent: string = "unknown"
  ) {}

  async complete(
    messages: ChatMessage[],
    opts?: ProviderCompleteOptions
  ): Promise<LlmExecution> {
    const startedAt = nowDate();
    let ZAIModule: any;
    try {
      // Dynamic import so this module loads cleanly in environments where
      // the SDK is not installed.
      ZAIModule = await import("z-ai-web-dev-sdk");
    } catch (err: any) {
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        status: "FAILED",
        error: `z-ai-web-dev-sdk not available: ${err?.message ?? String(err)}`,
      });
    }
    try {
      const ZAI = ZAIModule.default ?? ZAIModule;
      const zai = await ZAI.create();
      // The z-ai SDK does not accept role "system"; remap to "assistant".
      const adapted = messages.map((m) => ({
        role: m.role === "system" ? ("assistant" as const) : m.role,
        content: m.content,
      }));

      // The SDK does not currently support AbortSignal in the create() shape
      // we use. We emulate a timeout by racing the SDK call against a timer.
      const timeoutMs = opts?.timeout;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise =
        timeoutMs && timeoutMs > 0
          ? new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error("timeout")),
                timeoutMs
              );
            })
          : null;

      let completion: any;
      try {
        const p = zai.chat.completions.create({
          messages: adapted,
          thinking: { type: "disabled" },
        });
        completion = timeoutPromise
          ? await Promise.race([p, timeoutPromise])
          : await p;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      const content = completion?.choices?.[0]?.message?.content ?? "";
      if (!content) {
        return buildExecution({
          provider: this.kind,
          model: this.model,
          agent: this.agent,
          startedAt,
          completedAt: nowDate(),
          inputTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
          outputTokens: 0,
          status: "INVALID_RESPONSE",
          error: "Empty content in z-ai response",
        });
      }
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        inputTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
        outputTokens: estimateTokens(content),
        status: "SUCCEEDED",
        content,
      });
    } catch (err: any) {
      const status = /timeout/i.test(err?.message ?? "") ? "TIMEOUT" : "FAILED";
      return buildExecution({
        provider: this.kind,
        model: this.model,
        agent: this.agent,
        startedAt,
        completedAt: nowDate(),
        status,
        error: err?.message ?? String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Execution policy + retry semantics
// ---------------------------------------------------------------------------

export interface ExecutionPolicy {
  maxRetries: number; // additional attempts after the first
  timeoutMs: number;
  retryOn: ExecutionStatus[];
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  maxRetries: 2,
  timeoutMs: 60_000,
  retryOn: ["TIMEOUT", "RATE_LIMITED"],
};

// ---------------------------------------------------------------------------
// TemplateAdapter guard — only allowed when FORGE_ALLOW_TEMPLATE=true AND
// NODE_ENV !== 'production'. This is the ONLY way to use the simulated
// template adapter; the gateway itself never falls back to it.
// ---------------------------------------------------------------------------

export function isTemplateAdapterAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.FORGE_ALLOW_TEMPLATE === "true";
}

// ---------------------------------------------------------------------------
// LLM Gateway
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  timeout?: number;
  signal?: AbortSignal;
  policy?: Partial<ExecutionPolicy>;
}

export class LLMGateway {
  private providers = new Map<string, LLMProvider>();
  private agentAssignments = new Map<string, string>(); // agentType -> providerName
  private defaultProvider: string | null = null;

  /**
   * Register a provider. If `setDefault` is true (or no default exists yet),
   * this becomes the default for agents with no explicit assignment.
   */
  registerProvider(
    name: string,
    adapter: LLMProvider,
    opts?: { setDefault?: boolean; defaultForAgents?: string[] }
  ): void {
    this.providers.set(name, adapter);
    if (opts?.setDefault || this.defaultProvider === null) {
      this.defaultProvider = name;
    }
    if (opts?.defaultForAgents) {
      for (const agent of opts.defaultForAgents) {
        this.agentAssignments.set(agent, name);
      }
    }
  }

  /**
   * Explicitly assign a provider to an agent type.
   */
  assignAgent(agentType: string, providerName: string): void {
    this.agentAssignments.set(agentType, providerName);
  }

  hasProviders(): boolean {
    return this.providers.size > 0;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getProviderForAgent(agentType: string): LLMProvider | null {
    const name =
      this.agentAssignments.get(agentType) ?? this.defaultProvider ?? null;
    if (!name) return null;
    return this.providers.get(name) ?? null;
  }

  /**
   * Execute an LLM call with the policy (retry, timeout) applied.
   *
   * Returns an LlmExecution record. If no provider is available, returns a
   * BLOCKED execution without attempting any network call.
   */
  async execute(
    agentType: string,
    messages: ChatMessage[],
    opts?: ExecuteOptions
  ): Promise<LlmExecution> {
    const provider = this.getProviderForAgent(agentType);
    if (!provider) {
      return buildExecution({
        provider: "none",
        model: "none",
        agent: agentType,
        startedAt: nowDate(),
        completedAt: nowDate(),
        status: "BLOCKED",
        error: "No usable implementation model available",
      });
    }

    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      ...(opts?.policy ?? {}),
    };
    const timeout = opts?.timeout ?? policy.timeoutMs;
    const maxAttempts = 1 + Math.max(0, policy.maxRetries);

    let lastExec: LlmExecution | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Honour caller cancellation between attempts.
      if (opts?.signal?.aborted) {
        return buildExecution({
          provider: provider.kind,
          model: provider.model,
          agent: agentType,
          startedAt: nowDate(),
          completedAt: nowDate(),
          attempt,
          status: "CANCELLED",
          error: "Caller aborted before attempt",
        });
      }
      const exec = await provider.complete(messages, {
        timeout,
        signal: opts?.signal,
      });
      // Stamp attempt + agentType (provider doesn't know the agentType).
      exec.attempt = attempt;
      exec.agent = agentType;
      lastExec = exec;

      if (exec.status === "SUCCEEDED") {
        return exec;
      }
      // If the policy says we should not retry on this status, stop early.
      if (!policy.retryOn.includes(exec.status)) {
        return exec;
      }
      // Brief backoff before retry (only on retryable statuses).
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt, exec.status));
      }
    }
    return lastExec ?? buildExecution({
      provider: provider.kind,
      model: provider.model,
      agent: agentType,
      startedAt: nowDate(),
      completedAt: nowDate(),
      status: "FAILED",
      error: "No attempts executed",
    });
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number, status: ExecutionStatus): number {
  // Rate-limited: longer backoff. Timeout: short backoff (transient).
  const base = status === "RATE_LIMITED" ? 1500 : 250;
  return Math.min(base * Math.pow(2, attempt - 1), 10_000);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _cachedGateway: LLMGateway | null = null;
let _zaiAvailabilityChecked = false;
let _zaiAvailable = false;

/**
 * Returns true if z-ai-web-dev-sdk can be loaded and ZAI.create() succeeds.
 * Cached after first check.
 */
export async function isZaiAvailable(): Promise<boolean> {
  if (_zaiAvailabilityChecked) return _zaiAvailable;
  _zaiAvailabilityChecked = true;
  try {
    const mod: any = await import("z-ai-web-dev-sdk");
    const ZAI = mod.default ?? mod;
    await ZAI.create();
    _zaiAvailable = true;
  } catch {
    _zaiAvailable = false;
  }
  return _zaiAvailable;
}

/**
 * Create the gateway with the z-ai adapter registered as default if the SDK
 * is available. BYOK providers are registered separately by the orchestrator
 * (via registerProvider) once it loads the user's LlmProvider rows.
 *
 * If z-ai is unavailable AND no BYOK providers are registered, the gateway
 * has zero providers — every execute() call returns BLOCKED.
 */
export async function createGateway(): Promise<LLMGateway> {
  if (_cachedGateway) return _cachedGateway;
  const gw = new LLMGateway();
  if (await isZaiAvailable()) {
    gw.registerProvider("zai", new ZaiAdapter("glm-4.6"), { setDefault: true });
  }
  _cachedGateway = gw;
  return gw;
}

/**
 * Reset the cached gateway (mainly useful for tests / hot-reload scenarios
 * in dev where env vars change between requests).
 */
export function resetGateway(): void {
  _cachedGateway = null;
  _zaiAvailabilityChecked = false;
  _zaiAvailable = false;
}

// ---------------------------------------------------------------------------
// Legacy compatibility — buildAdapter + LlmAdapter shim
//
// The orchestrator still calls `buildAdapter({ provider, model, apiKey, baseUrl })`
// and uses the legacy LlmAdapter interface (returns CompletionResult). We wrap
// a new LLMProvider into that interface here so existing callers don't need
// changes.
// ---------------------------------------------------------------------------

function wrapProviderAsAdapter(
  provider: LLMProvider,
  agent: string = "unknown"
): LlmAdapter {
  return {
    kind: provider.kind,
    model: provider.model,
    async complete(messages: ChatMessage[]): Promise<CompletionResult> {
      const exec = await provider.complete(messages);
      return {
        content: exec.content,
        tokensInput: exec.inputTokens,
        tokensOutput: exec.outputTokens,
        model: exec.model,
        durationMs: exec.latency,
        success: exec.status === "SUCCEEDED",
        error: exec.error ?? undefined,
      };
    },
  };
}

/**
 * Legacy adapter factory. Maps a provider kind + credentials to the
 * appropriate real adapter. Returns an LlmAdapter (legacy interface).
 *
 * If `provider === "zai"` and z-ai is unavailable, the returned adapter will
 * produce FAILED executions on every call (NOT a TemplateAdapter fallback).
 */
export function buildAdapter(opts: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  agent?: string;
}): LlmAdapter {
  const { provider, model, apiKey, baseUrl, agent } = opts;
  const agentName = agent ?? "unknown";

  if (provider === "zai") {
    return wrapProviderAsAdapter(new ZaiAdapter(model || "glm-4.6", agentName), agentName);
  }

  if (provider === "anthropic") {
    if (!apiKey) return blockedAdapter("anthropic", model, "Missing API key", agentName);
    return wrapProviderAsAdapter(
      new AnthropicAdapter(model, apiKey, baseUrl, agentName),
      agentName
    );
  }
  if (provider === "google") {
    if (!apiKey) return blockedAdapter("google", model, "Missing API key", agentName);
    return wrapProviderAsAdapter(
      new GoogleAdapter(model, apiKey, baseUrl, agentName),
      agentName
    );
  }
  if (provider === "xai") {
    if (!apiKey) return blockedAdapter("xai", model, "Missing API key", agentName);
    return wrapProviderAsAdapter(
      new XaiAdapter(model, apiKey, baseUrl, agentName),
      agentName
    );
  }
  if (provider === "ollama" || provider === "local") {
    // Local Ollama typically needs no API key.
    return wrapProviderAsAdapter(
      new OllamaAdapter(model, baseUrl || "http://localhost:11434/v1", agentName),
      agentName
    );
  }
  // openai or any OpenAI-compatible endpoint.
  if (apiKey) {
    const defaultUrls: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      "openai-compat": baseUrl || "https://api.openai.com/v1",
    };
    const url = baseUrl || defaultUrls[provider] || defaultUrls.openai;
    return wrapProviderAsAdapter(
      new OpenAIAdapter(model, apiKey, url, agentName),
      agentName
    );
  }
  // No key + no z-ai → BLOCKED. We do NOT fall back to TemplateAdapter.
  return blockedAdapter(
    provider,
    model,
    "No usable implementation model available (no API key and z-ai unavailable)",
    agentName
  );
}

function blockedAdapter(
  providerKind: string,
  model: string,
  reason: string,
  agent: string
): LlmAdapter {
  return {
    kind: providerKind,
    model,
    async complete(): Promise<CompletionResult> {
      return {
        content: "",
        tokensInput: 0,
        tokensOutput: 0,
        model,
        durationMs: 0,
        success: false,
        error: reason,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// JSON extraction helper (kept from the original llm.ts)
// ---------------------------------------------------------------------------

export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  // Strip markdown fences.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Find the first { or [ and try to parse from there.
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  let start = -1;
  if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
  else if (firstObj >= 0) start = firstObj;
  else if (firstArr >= 0) start = firstArr;
  if (start < 0) return null;
  // Find matching close by scanning from start.
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = t.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch {
          return null;
        }
      }
    }
  }
  // Last-ditch: try parsing the whole trimmed text.
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default model per agent role (single-LLM mode). Kept for backward compat.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_FOR_AGENT: Record<AgentType, string> = {
  ARCHITECT: "glm-4.6",
  ARCHITECTURE_GUARDIAN: "glm-4.6",
  CODE_REVIEWER: "glm-4.6",
  FRONTEND: "glm-4.6",
  BACKEND: "glm-4.6",
  DATABASE: "glm-4.6",
  INFRASTRUCTURE: "glm-4.6",
  INTEGRATION: "glm-4.6",
  QA: "glm-4.6",
};
