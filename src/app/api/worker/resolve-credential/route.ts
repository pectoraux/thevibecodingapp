import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkerToken } from "@/lib/worker-auth";
import { decryptSecretOrNull } from "@/lib/crypto";

// POST /api/worker/resolve-credential
//
// Phase 10: BYOK credential resolution.
// The worker calls this to get the decrypted API key for a BYOK provider.
// The worker must be authenticated with an execution token.
// The credential is NEVER sent to the LLM or browser — only to the authenticated worker.
export async function POST(req: Request) {
  try {
    const token = getWorkerToken(req, "EXECUTION");
    if (!token) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    if (!token.executionId) {
      return NextResponse.json({ error: "Execution token required" }, { status: 403 });
    }

    const { providerId } = await req.json();

    if (!providerId) {
      return NextResponse.json({ error: "providerId required" }, { status: 400 });
    }

    // Look up the provider.
    const provider = await db.llmProvider.findUnique({ where: { id: providerId } });
    if (!provider) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    // Decrypt the API key.
    const apiKey = decryptSecretOrNull(provider.apiKey);
    if (!apiKey) {
      return NextResponse.json({ error: "Credential could not be decrypted" }, { status: 500 });
    }

    // Return the decrypted key to the authenticated worker.
    // The worker uses this to call the provider's API directly.
    // The key is NEVER logged, NEVER sent to the LLM prompt, NEVER stored in the worker.
    return NextResponse.json({
      apiKey,
      provider: provider.provider,
      model: provider.model,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
