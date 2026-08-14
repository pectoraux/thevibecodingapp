import { NextResponse } from "next/server";
import { getSession, requireUserRole } from "@/lib/auth";

// GET /api/auth/me — returns the current session user (or null if logged out).
//   Returns: { user: { id, email, name, role, isDemo } | null }
export async function GET() {
  const role = await requireUserRole();
  if (!role) {
    return NextResponse.json({ user: null });
  }
  const session = await getSession();
  const u = (session?.user as any) ?? null;
  if (!u) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({
    user: {
      id: u.id ?? null,
      email: u.email ?? null,
      name: u.name ?? null,
      role: u.role ?? null,
      isDemo: !!u.isDemo,
    },
  });
}
