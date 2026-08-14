import { NextResponse } from "next/server";
import { getFile } from "@/lib/repo";
import { parseRepoFile } from "../../../../_lib";

// GET /api/projects/[id]/repository/files?path=...
//   Returns: { file: RepoFile } — file shape includes pre-parsed suspiciousPatterns.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return NextResponse.json({ error: "Missing query parameter: path" }, { status: 400 });
    }
    const file = await getFile(id, path);
    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ file: parseRepoFile(file) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch file" }, { status: 500 });
  }
}
