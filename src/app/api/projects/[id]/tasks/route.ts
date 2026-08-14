import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseTask } from "../../../_lib";

// GET /api/projects/[id]/tasks — list all tasks (JSON fields pre-parsed)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const tasks = await db.task.findMany({
      where: { projectId: id },
      orderBy: [{ priority: "asc" }, { code: "asc" }],
    });
    return NextResponse.json({ tasks: tasks.map(parseTask) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list tasks" }, { status: 500 });
  }
}
