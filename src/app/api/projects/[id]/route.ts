import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseArchitecture, readJsonBody } from "../../_lib";

// GET /api/projects/[id] — full project detail + architecture + counts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await db.project.findUnique({ where: { id } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const architecture = await db.architecture.findUnique({ where: { projectId: id } });

    const [
      tasks,
      completedTasks,
      failedTasks,
      agents,
      credentials,
      configuredCredentials,
      commits,
      files,
      events,
    ] = await Promise.all([
      db.task.count({ where: { projectId: id } }),
      db.task.count({ where: { projectId: id, status: "COMPLETED" } }),
      db.task.count({ where: { projectId: id, status: "FAILED" } }),
      db.agentAssignment.count({ where: { projectId: id } }),
      db.credential.count({ where: { projectId: id } }),
      db.credential.count({ where: { projectId: id, configured: true } }),
      db.repoCommit.count({ where: { projectId: id } }),
      db.repoFile.count({ where: { projectId: id } }),
      db.buildEvent.count({ where: { projectId: id } }),
    ]);

    return NextResponse.json({
      project,
      architecture: parseArchitecture(architecture),
      counts: {
        tasks,
        completedTasks,
        failedTasks,
        agents,
        credentials,
        configuredCredentials,
        commits,
        files,
        events,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch project" }, { status: 500 });
  }
}

// PATCH /api/projects/[id] — update editable project fields
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJsonBody(req);
    const { name, description, productSpec, requirements, stack } = body || {};
    const existing = await db.project.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const data: Record<string, string> = {};
    if (typeof name === "string") data.name = name;
    if (typeof description === "string") data.description = description;
    if (typeof productSpec === "string") data.productSpec = productSpec;
    if (typeof requirements === "string") data.requirements = requirements;
    if (typeof stack === "string") data.stack = stack;
    const updated = await db.project.update({ where: { id }, data });
    return NextResponse.json({ project: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to update project" }, { status: 500 });
  }
}

// DELETE /api/projects/[id] — cascade delete (handled by Prisma schema)
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await db.project.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to delete project" }, { status: 500 });
  }
}
