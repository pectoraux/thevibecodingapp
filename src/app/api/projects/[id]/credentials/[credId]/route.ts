import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { obfuscate } from "@/lib/crypto";
import { requireUserId } from "@/lib/auth";
import { stripCredential, readJsonBody } from "../../../../_lib";

// PATCH /api/projects/[id]/credentials/[credId]
//   Body: { value, environment? }
//   Side effect: obfuscates value, sets configured=true, validated=true (basic non-empty check)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; credId: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, credId } = await params;
    // Verify the project belongs to the user before mutating any credential under it.
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await readJsonBody(req);
    const { value, environment } = body || {};
    if (typeof value !== "string") {
      return NextResponse.json({ error: "Missing required field: value" }, { status: 400 });
    }
    const existing = await db.credential.findFirst({
      where: { id: credId, projectId: id },
    });
    if (!existing) {
      return NextResponse.json({ error: "Credential not found" }, { status: 404 });
    }
    const trimmed = value.trim();
    const updated = await db.credential.update({
      where: { id: credId },
      data: {
        value: obfuscate(value),
        configured: true,
        validated: trimmed.length > 0,
        ...(environment ? { environment } : {}),
      },
    });
    return NextResponse.json({ credential: stripCredential(updated) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to update credential" }, { status: 500 });
  }
}
