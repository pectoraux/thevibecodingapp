// Forge — LLM provider abstraction.
//
// All agent execution flows through this module so we can swap providers
// (OpenAI, Anthropic, Google, xAI, local) without touching the orchestration
// engine. The default adapter uses z-ai-web-dev-sdk which is the in-process
// LLM available in this sandbox.

import ZAI from "z-ai-web-dev-sdk";
import type { AgentType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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

// z-ai-web-dev-sdk is the in-process LLM. Reuse one instance.
let _zai: any = null;
async function getZai() {
  if (!_zai) {
    _zai = await ZAI.create();
  }
  return _zai;
}

// Rough token estimate (~4 chars/token).
function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

// ---------------------------------------------------------------------------
// z-ai adapter (default; uses sandbox LLM)
// ---------------------------------------------------------------------------

export class ZaiAdapter implements LlmAdapter {
  kind = "zai";
  constructor(public model = "glm-4.6") {}

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    const start = Date.now();
    try {
      const zai = await getZai();
      // z-ai-web-dev-sdk uses 'assistant' role for system prompts.
      const adapted = messages.map((m) => ({
        role: m.role === "system" ? ("assistant" as const) : m.role,
        content: m.content,
      }));
      const completion = await zai.chat.completions.create({
        messages: adapted,
        thinking: { type: "disabled" },
      });
      const content = completion.choices?.[0]?.message?.content ?? "";
      const tokensInput = estimateTokens(
        messages.map((m) => m.content).join("\n")
      );
      const tokensOutput = estimateTokens(content);
      return {
        content,
        tokensInput,
        tokensOutput,
        model: this.model,
        durationMs: Date.now() - start,
        success: true,
      };
    } catch (err: any) {
      return {
        content: "",
        tokensInput: 0,
        tokensOutput: 0,
        model: this.model,
        durationMs: Date.now() - start,
        success: false,
        error: err?.message ?? String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible adapter (used when BYOK supplies a real key+baseURL)
// ---------------------------------------------------------------------------

export class OpenAICompatAdapter implements LlmAdapter {
  kind = "openai-compat";
  constructor(
    public model: string,
    private apiKey: string,
    private baseUrl: string
  ) {}

  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    const start = Date.now();
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
      });
      if (!res.ok) {
        return {
          content: "",
          tokensInput: 0,
          tokensOutput: 0,
          model: this.model,
          durationMs: Date.now() - start,
          success: false,
          error: `HTTP ${res.status}: ${await res.text()}`,
        };
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "";
      return {
        content,
        tokensInput: data?.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n")),
        tokensOutput: data?.usage?.completion_tokens ?? estimateTokens(content),
        model: this.model,
        durationMs: Date.now() - start,
        success: true,
      };
    } catch (err: any) {
      return {
        content: "",
        tokensInput: 0,
        tokensOutput: 0,
        model: this.model,
        durationMs: Date.now() - start,
        success: false,
        error: err?.message ?? String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function buildAdapter(opts: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): LlmAdapter {
  const { provider, model, apiKey, baseUrl } = opts;
  if (provider === "zai") {
    return new ZaiAdapter(model || "glm-4.6");
  }
  // All BYOK providers route through OpenAI-compatible adapter.
  if (apiKey) {
    const urls: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      google: "https://generativelanguage.googleapis.com/v1beta/openai",
      xai: "https://api.x.ai/v1",
      local: baseUrl || "http://localhost:11434/v1",
    };
    return new OpenAICompatAdapter(model, apiKey, baseUrl || urls[provider] || urls.openai);
  }
  // Fallback to z-ai sandbox LLM (single-LLM mode).
  return new ZaiAdapter("glm-4.6");
}

// ---------------------------------------------------------------------------
// JSON extraction helper (robust against markdown fences)
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
// Default model per agent role (single-LLM mode). When BYOK providers are
// configured the orchestrator will prefer them by capability, but these are
// the fallbacks.
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
