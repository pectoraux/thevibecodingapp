import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/projects/[id]/adrs — list ADRs (Architecture Decision Records)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const adrs = await db.adr.findMany({
      where: { projectId: id },
      orderBy: { number: "asc" },
    });
    return NextResponse.json({ adrs });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list ADRs" }, { status: 500 });
  }
}
