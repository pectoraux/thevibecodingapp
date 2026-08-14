import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth";
import { stripCredential } from "../../../_lib";

// GET /api/projects/[id]/credentials — list credentials manifest (NEVER expose value)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const credentials = await db.credential.findMany({
      where: { projectId: id },
      orderBy: [{ required: "desc" }, { name: "asc" }],
    });
    return NextResponse.json({ credentials: credentials.map(stripCredential) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list credentials" }, { status: 500 });
  }
}
