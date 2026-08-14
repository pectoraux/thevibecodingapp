// Forge — NextAuth v4 configuration (Credentials provider + JWT sessions).
//
// Uses bcryptjs for password hashing. Sessions are JWT-based (required for
// Credentials provider). The JWT carries userId, role, and isDemo flag so
// API routes can authorize without a DB lookup on every request.

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export const authOptions: NextAuthOptions = {
  // PrismaAdapter is NOT used here because the Credentials provider requires
  // JWT sessions. We manage User/Account/Session tables manually for the
  // waitlist + admin approval flow.
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const email = credentials.email.toLowerCase().trim();
        const user = await db.user.findUnique({
          where: { email },
        });
        if (!user || !user.passwordHash) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role,
          isDemo: user.isDemo,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.role = (user as any).role;
        token.isDemo = (user as any).isDemo;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
        (session.user as any).isDemo = token.isDemo;
      }
      return session;
    },
  },
  pages: {
    // We handle sign-in in the main page UI (modal), not a separate route.
    // NextAuth will still redirect here if needed.
    signIn: "/",
  },
  secret: process.env.NEXTAUTH_SECRET,
};

// Helper for API routes — returns the session or null.
export async function getSession() {
  const { getServerSession } = await import("next-auth");
  return getServerSession(authOptions);
}

// Helper — returns the user id or null. Use in API routes to enforce auth.
export async function requireUserId(): Promise<string | null> {
  const session = await getSession();
  return (session?.user as any)?.id ?? null;
}

// Helper — returns the user role or null.
export async function requireUserRole(): Promise<string | null> {
  const session = await getSession();
  return (session?.user as any)?.role ?? null;
}

// Helper — returns true if the user is an admin (real or demo).
export async function isAdmin(): Promise<boolean> {
  const role = await requireUserRole();
  return role === "ADMIN" || role === "DEMO_ADMIN";
}
