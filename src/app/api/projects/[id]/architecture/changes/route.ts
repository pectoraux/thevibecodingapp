import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureBuildEvent } from "@/lib/events";
import { BuildEventType } from "@/lib/types";
import { readJsonBody } from "../../../../_lib";

// Helper: parse a JSON-array string field on a change request for the response.
function parseChangeRequest(c: any) {
  return {
    ...c,
    affectedComponents: c.affectedComponents ? safeJson(c.affectedComponents, []) : [],
    affectedTests: c.affectedTests ? safeJson(c.affectedTests, []) : [],
    affectedApis: c.affectedApis ? safeJson(c.affectedApis, []) : [],
    affectedDependencies: c.affectedDependencies ? safeJson(c.affectedDependencies, []) : [],
  };
}

function safeJson<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// GET /api/projects/[id]/architecture/changes — list change requests
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const changeRequests = await db.architectureChangeRequest.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      changeRequests: changeRequests.map(parseChangeRequest),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to list change requests" }, { status: 500 });
  }
}

// POST /api/projects/[id]/architecture/changes — create a new change request
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJsonBody(req);
    const {
      title,
      problem,
      affectedComponents,
      proposedChange,
      rationale,
      risks,
      migrationRequirements,
      affectedTests,
      affectedApis,
      affectedDependencies,
      estimatedImpact,
    } = body || {};
    if (!title || !problem || !proposedChange) {
      return NextResponse.json(
        { error: "Missing required fields: title, problem, proposedChange" },
        { status: 400 }
      );
    }
    const project = await db.project.findUnique({ where: { id } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const created = await db.architectureChangeRequest.create({
      data: {
        projectId: id,
        title,
        problem,
        affectedComponents: JSON.stringify(Array.isArray(affectedComponents) ? affectedComponents : []),
        proposedChange,
        rationale: rationale ?? "",
        risks: risks ?? "",
        migrationRequirements: migrationRequirements ?? "",
        affectedTests: JSON.stringify(Array.isArray(affectedTests) ? affectedTests : []),
        affectedApis: JSON.stringify(Array.isArray(affectedApis) ? affectedApis : []),
        affectedDependencies: JSON.stringify(Array.isArray(affectedDependencies) ? affectedDependencies : []),
        estimatedImpact: estimatedImpact ?? "",
        status: "OPEN",
      },
    });
    await ensureBuildEvent({
      projectId: id,
      type: BuildEventType.CHANGE_REQUEST_CREATED,
      level: "info",
      message: `Architecture change request created: ${title}`,
      payload: JSON.stringify({ id: created.id, title }),
    });
    return NextResponse.json({ changeRequest: parseChangeRequest(created) }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to create change request" }, { status: 500 });
  }
}
