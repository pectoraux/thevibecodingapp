import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUserRole } from "@/lib/auth";

// GET /api/admin/stats — ADMIN only.
//   Returns aggregate counts across the platform:
//   { totalUsers, totalProjects, totalProviders, waitlistPending, waitlistApproved,
//     waitlistRejected, totalTasks, totalCommits, totalFiles }
export async function GET() {
  try {
    const role = await requireUserRole();
    if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const [
      totalUsers,
      totalProjects,
      totalProviders,
      waitlistPending,
      waitlistApproved,
      waitlistRejected,
      totalTasks,
      totalCommits,
      totalFiles,
    ] = await Promise.all([
      db.user.count(),
      db.project.count(),
      db.llmProvider.count(),
      db.waitlistEntry.count({ where: { status: "PENDING" } }),
      db.waitlistEntry.count({ where: { status: "APPROVED" } }),
      db.waitlistEntry.count({ where: { status: "REJECTED" } }),
      db.task.count(),
      db.repoCommit.count(),
      db.repoFile.count(),
    ]);
    return NextResponse.json({
      totalUsers,
      totalProjects,
      totalProviders,
      waitlist: {
        pending: waitlistPending,
        approved: waitlistApproved,
        rejected: waitlistRejected,
      },
      totalTasks,
      totalCommits,
      totalFiles,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to fetch admin stats" }, { status: 500 });
  }
}
