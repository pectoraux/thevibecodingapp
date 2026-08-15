// LLM Gateway — BYOK provider abstraction.
// Routes LLM calls to the configured provider (OpenAI, Anthropic, Google, xAI, or zai default).

export interface LlmResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  success: boolean;
  error?: string;
}

export async function callLLM(spec: any, messages: { role: string; content: string }[], apiCall: (path: string, method: string, body?: any, token?: string) => Promise<any>, executionToken: string | null): Promise<LlmResult> {
  const provider = spec.modelProviderRef;
  const model = spec.model || "glm-4.6";

  if (provider && provider.provider !== "zai") {
    return await callByokProvider(provider, model, messages, apiCall, executionToken);
  }

  // Default: z-ai-web-dev-sdk (sandbox).
  try {
    const ZAI = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const adapted = messages.map((m) => ({
      role: m.role === "system" ? "assistant" : m.role,
      content: m.content,
    }));
    const completion = await zai.chat.completions.create({
      messages: adapted as any,
      thinking: { type: "disabled" },
    });
    const content = completion.choices?.[0]?.message?.content || "";
    return {
      content,
      tokensInput: Math.ceil(messages.map((m) => m.content).join("").length / 4),
      tokensOutput: Math.ceil(content.length / 4),
      model,
      success: true,
    };
  } catch (err: any) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: err.message };
  }
}

async function callByokProvider(provider: any, model: string, messages: any[], apiCall: (path: string, method: string, body?: any, token?: string) => Promise<any>, executionToken: string | null): Promise<LlmResult> {
  try {
    const credResult = await apiCall("/api/worker/resolve-credential", "POST", {
      providerId: provider.providerId,
    }, executionToken!);
    const apiKey = credResult.apiKey;
    if (!apiKey) {
      return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: "No API key resolved" };
    }

    // Route to provider-specific adapter.
    switch (provider.provider) {
      case "anthropic":
        return await callAnthropic(apiKey, model, messages);
      case "google":
        return await callGoogle(apiKey, model, messages);
      case "openai":
      case "xai":
      case "openai-compat":
      default:
        return await callOpenAICompatible(provider, apiKey, model, messages);
    }
  } catch (err: any) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: err.message };
  }
}

// --- Provider-specific adapters ---

async function callOpenAICompatible(provider: any, apiKey: string, model: string, messages: any[]): Promise<LlmResult> {
  const urls: Record<string, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    xai: "https://api.x.ai/v1/chat/completions",
  };
  const baseUrl = urls[provider.provider] || provider.baseUrl || urls.openai;

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
  });

  if (!res.ok) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: `HTTP ${res.status}` };
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  return {
    content,
    tokensInput: data.usage?.prompt_tokens || 0,
    tokensOutput: data.usage?.completion_tokens || 0,
    model,
    success: true,
  };
}

async function callAnthropic(apiKey: string, model: string, messages: any[]): Promise<LlmResult> {
  // Anthropic Messages API has a different format.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      system: messages.find((m) => m.role === "system")?.content,
    }),
  });

  if (!res.ok) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: `Anthropic HTTP ${res.status}` };
  }
  const data = await res.json();
  const content = data.content?.[0]?.text || "";
  return {
    content,
    tokensInput: data.usage?.input_tokens || 0,
    tokensOutput: data.usage?.output_tokens || 0,
    model,
    success: true,
  };
}

async function callGoogle(apiKey: string, model: string, messages: any[]): Promise<LlmResult> {
  // Google Gemini API.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      systemInstruction: messages.find((m) => m.role === "system")
        ? { parts: [{ text: messages.find((m) => m.role === "system")!.content }] }
        : undefined,
    }),
  });

  if (!res.ok) {
    return { content: "", tokensInput: 0, tokensOutput: 0, model, success: false, error: `Google HTTP ${res.status}` };
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return {
    content,
    tokensInput: data.usageMetadata?.promptTokenCount || 0,
    tokensOutput: data.usageMetadata?.candidatesTokenCount || 0,
    model,
    success: true,
  };
}
