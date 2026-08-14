import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { obfuscate } from "@/lib/crypto";
import { stripProvider, readJsonBody } from "../_lib";

// GET /api/providers — list all configured LLM providers (BYOK)
export async function GET() {
  try {
    const providers = await db.llmProvider.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ providers: providers.map(stripProvider) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list providers" }, { status: 500 });
  }
}

// POST /api/providers — create a new LLM provider (obfuscate apiKey before storing)
export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const { name, provider, model, apiKey, capabilities, contextWindow, pricingPer1kInput, pricingPer1kOutput, isDefault } = body || {};
    if (!name || !provider || !model || !apiKey) {
      return NextResponse.json(
        { error: "Missing required fields: name, provider, model, apiKey" },
        { status: 400 }
      );
    }
    // If isDefault, unset any existing default first.
    if (isDefault) {
      await db.llmProvider.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }
    const created = await db.llmProvider.create({
      data: {
        name,
        provider,
        model,
        apiKey: obfuscate(apiKey),
        capabilities: JSON.stringify(Array.isArray(capabilities) ? capabilities : []),
        contextWindow: typeof contextWindow === "number" ? contextWindow : 128000,
        pricingPer1kInput: typeof pricingPer1kInput === "number" ? pricingPer1kInput : 0,
        pricingPer1kOutput: typeof pricingPer1kOutput === "number" ? pricingPer1kOutput : 0,
        isDefault: !!isDefault,
      },
    });
    return NextResponse.json({ provider: stripProvider(created) }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to create provider" }, { status: 500 });
  }
}
