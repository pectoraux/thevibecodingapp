import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { stripCredential } from "../../../_lib";

// GET /api/projects/[id]/credentials — list credentials manifest (NEVER expose value)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const credentials = await db.credential.findMany({
      where: { projectId: id },
      orderBy: [{ required: "desc" }, { name: "asc" }],
    });
    return NextResponse.json({ credentials: credentials.map(stripCredential) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list credentials" }, { status: 500 });
  }
}
