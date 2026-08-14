import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { requireUserId, requireUserRole } from "@/lib/auth";
import { readJsonBody } from "../../../_lib";

// Helper: generate a reasonably strong random password.
function generatePassword(length = 12): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*";
  const bytes = new Uint32Array(length);
  // Bun/Node both have globalThis.crypto.getRandomValues in modern runtimes.
  (globalThis.crypto as any).getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// POST /api/waitlist/[entryId]/approve — ADMIN only.
//   Body: { password? }
//   - Creates a User account from the waitlist entry (role=USER, bcrypt-hashed password).
//   - If no password provided, generates a random one.
//   - Updates the WaitlistEntry: status=APPROVED, convertedUserId, reviewedAt, reviewedBy.
//   - Returns { user: { id, email, name }, password: string } — the password is returned
//     ONCE so the admin can share it with the user out-of-band.
export async function POST(req: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const role = await requireUserRole();
    if (role !== "ADMIN" && role !== "DEMO_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const adminUserId = await requireUserId();
    if (!adminUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { entryId } = await params;
    const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } });
    if (!entry) {
      return NextResponse.json({ error: "Waitlist entry not found" }, { status: 404 });
    }
    if (entry.status === "APPROVED") {
      return NextResponse.json(
        { error: "This entry has already been approved" },
        { status: 409 }
      );
    }

    const body = await readJsonBody(req);
    const password =
      typeof body?.password === "string" && body.password.length >= 8
        ? body.password
        : generatePassword(12);

    // Guard against a race condition where a User with this email was created
    // between the waitlist submission and approval.
    const existingUser = await db.user.findUnique({ where: { email: entry.email } });
    if (existingUser) {
      // Link the waitlist entry to the existing user and mark as approved.
      await db.waitlistEntry.update({
        where: { id: entryId },
        data: {
          status: "APPROVED",
          convertedUserId: existingUser.id,
          reviewedAt: new Date(),
          reviewedBy: adminUserId,
        },
      });
      return NextResponse.json(
        {
          user: {
            id: existingUser.id,
            email: existingUser.email,
            name: existingUser.name ?? null,
          },
          password: null,
          note: "An account with this email already existed; entry linked but no new password was set.",
        },
        { status: 200 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await db.user.create({
      data: {
        email: entry.email,
        name: entry.name ?? null,
        passwordHash,
        role: "USER",
        isDemo: false,
      },
    });

    await db.waitlistEntry.update({
      where: { id: entryId },
      data: {
        status: "APPROVED",
        convertedUserId: created.id,
        reviewedAt: new Date(),
        reviewedBy: adminUserId,
      },
    });

    return NextResponse.json(
      {
        user: { id: created.id, email: created.email, name: created.name ?? null },
        password,
      },
      { status: 201 }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to approve waitlist entry" }, { status: 500 });
  }
}
