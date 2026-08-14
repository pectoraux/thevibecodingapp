import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseArchitecture } from "../../../_lib";

// GET /api/projects/[id]/architecture — return the project's architecture (parsed JSON fields)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const architecture = await db.architecture.findUnique({ where: { projectId: id } });
    return NextResponse.json({ architecture: parseArchitecture(architecture) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch architecture" }, { status: 500 });
  }
}
