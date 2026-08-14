import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { initRepository } from "@/lib/repo";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType, ProjectStatus } from "@/lib/types";
import { readJsonBody } from "../_lib";

// GET /api/projects — list all projects (newest first), with task/credential counts
export async function GET() {
  try {
    const projects = await db.project.findMany({
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

// POST /api/projects — create a new DRAFT project + initialize its repo
export async function POST(req: Request) {
  try {
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

    // Initialize the virtual repository with README + .gitignore.
    try {
      await initRepository(project.id, name);
    } catch (repoErr: any) {
      // Non-fatal — surface in the response but keep the project.
      console.error("[initRepository] failed:", repoErr);
    }

    return NextResponse.json({ project }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to create project" }, { status: 500 });
  }
}
