// Forge — LLM provider abstraction (re-export shim).
//
// The real LLM gateway now lives in `./llm-gateway.ts`. This file re-exports
// the public API so existing callers that import from "@/lib/llm" keep
// working without code changes.
//
// Migration path:
//   - Old: `import { buildAdapter, ZaiAdapter, extractJson, type ChatMessage } from "@/lib/llm"`
//   - New: `import { LLMGateway, createGateway, extractJson, type LLMProvider } from "@/lib/llm-gateway"`
//
// The legacy `buildAdapter` + `LlmAdapter` interface are kept here for
// backward compatibility with the orchestrator.

export {
  // Types
  type ChatMessage,
  type CompletionResult,
  type LlmAdapter,
  type LlmExecution,
  type ExecutionStatus,
  type LLMProvider,
  type ProviderCompleteOptions,
  type ExecutionPolicy,
  type ExecuteOptions,
  // Adapters
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  XaiAdapter,
  OpenAICompatAdapter,
  OllamaAdapter,
  ZaiAdapter,
  // Gateway
  LLMGateway,
  createGateway,
  resetGateway,
  isZaiAvailable,
  isTemplateAdapterAllowed,
  // Policy
  DEFAULT_EXECUTION_POLICY,
  // Legacy factory
  buildAdapter,
  // Utility
  extractJson,
  // Default models
  DEFAULT_MODEL_FOR_AGENT,
} from "@/lib/llm-gateway";
