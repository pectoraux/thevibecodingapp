import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, ProjectStatus } from "@/lib/types";
import { requireUserId } from "@/lib/auth";
import { readJsonBody } from "../_lib";

// GET /api/projects — list the authenticated user's projects (newest first), with task/credential counts
export async function GET() {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const projects = await db.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            tasks: true,
            credentials: true,
          },
        },
      },
    });
    return NextResponse.json({ projects });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list projects" }, { status: 500 });
  }
}

// POST /api/projects — create a new DRAFT project (owned by the authenticated user).
// P16D-RECONCILE: no virtual-repo seeding — real Git/GitHub is the canonical source.
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await readJsonBody(req);
    const { name, description, productSpec, requirements, stack } = body || {};
    if (!name || !description) {
      return NextResponse.json(
        { error: "Missing required fields: name, description" },
        { status: 400 }
      );
    }
    const project = await db.project.create({
      data: {
        userId,
        name,
        description,
        productSpec: productSpec ?? "",
        requirements: requirements ?? "",
        stack: stack ?? "",
        status: ProjectStatus.DRAFT,
      },
    });

    // Emit a PROJECT_CREATED event.
    await ensureBuildEvent({
      projectId: project.id,
      type: BuildEventType.PROJECT_CREATED,
      level: "info",
      message: `Project “${project.name}” created`,
      payload: JSON.stringify({ name, description }),
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to create project" }, { status: 500 });
  }
}
