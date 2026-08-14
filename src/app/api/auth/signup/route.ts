import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readJsonBody } from "../../_lib";

// POST /api/auth/signup — add an email to the waitlist.
//   Body: { email, name? }
//   Creates a WaitlistEntry with status="PENDING".
//   Returns 409 if the email already exists in WaitlistEntry or User.
//   Public endpoint (no auth) — anyone can request access.
export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req);
    const emailRaw = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : null;
    if (!emailRaw || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw)) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }

    // 409 if the email is already on the waitlist.
    const existingWait = await db.waitlistEntry.findUnique({ where: { email: emailRaw } });
    if (existingWait) {
      return NextResponse.json(
        { error: "This email is already on the waitlist" },
        { status: 409 }
      );
    }

    // 409 if the email already has an active account.
    const existingUser = await db.user.findUnique({ where: { email: emailRaw } });
    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }

    await db.waitlistEntry.create({
      data: {
        email: emailRaw,
        name,
        status: "PENDING",
      },
    });

    return NextResponse.json({ ok: true, message: "Added to waitlist" }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Failed to join waitlist" }, { status: 500 });
  }
}
