"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  Loader2,
  LogIn,
  ShieldCheck,
  UserPlus,
  Wrench,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

import { apiGet, apiPost } from "./lib/api";
import { useForgeStore } from "./lib/store";

const DEMO_ADMIN = {
  email: "demo.admin@forge.local",
  password: "demo-admin-2024",
};
const DEMO_USER = {
  email: "demo.user@forge.local",
  password: "demo-user-2024",
};

function AuthFooter() {
  return (
    <footer className="mt-auto border-t bg-card/50 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Wrench className="size-3.5" />
          Forge
        </span>
        <span>Sign in or join the waitlist to get started.</span>
      </div>
    </footer>
  );
}

export function AuthScreen() {
  const setUser = useForgeStore((s) => s.setUser);
  const { toast } = useToast();
  const [mode, setMode] = React.useState<"login" | "waitlist">("login");

  // Re-probe session after a credentials sign-in so the Zustand store reflects
  // the new server-side auth state.
  const refreshMe = React.useCallback(async () => {
    try {
      const res = await apiGet<{ user: any | null }>("/api/auth/me");
      setUser(res.user ?? null);
    } catch {
      // ignore — user can retry
    }
  }, [setUser]);

  // ---------------- Login form ----------------
  const [loginEmail, setLoginEmail] = React.useState("");
  const [loginPassword, setLoginPassword] = React.useState("");
  const [loginLoading, setLoginLoading] = React.useState(false);

  async function handleLogin(e?: React.FormEvent) {
    e?.preventDefault();
    if (!loginEmail.trim() || !loginPassword) {
      toast({
        variant: "destructive",
        title: "Email and password are required",
      });
      return;
    }
    setLoginLoading(true);
    try {
      const res = await signIn("credentials", {
        email: loginEmail.trim(),
        password: loginPassword,
        redirect: false,
      });
      if (!res || res.error) {
        toast({
          variant: "destructive",
          title: "Sign-in failed",
          description: "Invalid email or password.",
        });
        return;
      }
      await refreshMe();
      toast({ title: "Signed in", description: "Welcome back to Forge." });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Sign-in failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoginLoading(false);
    }
  }

  // ---------------- Demo quick-login ----------------
  const [demoLoading, setDemoLoading] = React.useState<
    null | "admin" | "user"
  >(null);

  async function handleDemo(kind: "admin" | "user") {
    const creds = kind === "admin" ? DEMO_ADMIN : DEMO_USER;
    setDemoLoading(kind);
    try {
      const res = await signIn("credentials", {
        email: creds.email,
        password: creds.password,
        redirect: false,
      });
      if (!res || res.error) {
        toast({
          variant: "destructive",
          title: "Demo login failed",
          description: "The demo account could not be reached.",
        });
        return;
      }
      await refreshMe();
      toast({
        title: `Signed in as demo ${kind}`,
        description: `Logged in with ${creds.email}`,
      });
    } finally {
      setDemoLoading(null);
    }
  }

  // ---------------- Waitlist form ----------------
  const [wlEmail, setWlEmail] = React.useState("");
  const [wlName, setWlName] = React.useState("");
  const [wlLoading, setWlLoading] = React.useState(false);
  const [wlDone, setWlDone] = React.useState(false);

  async function handleWaitlist(e?: React.FormEvent) {
    e?.preventDefault();
    if (!wlEmail.trim()) {
      toast({ variant: "destructive", title: "Email is required" });
      return;
    }
    setWlLoading(true);
    try {
      await apiPost("/api/auth/signup", {
        email: wlEmail.trim(),
        name: wlName.trim() || undefined,
      });
      setWlDone(true);
      toast({
        title: "You're on the waitlist!",
        description: "We'll email you when your account is ready.",
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to join waitlist";
      toast({
        variant: "destructive",
        title: "Couldn't join waitlist",
        description: msg,
      });
    } finally {
      setWlLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10 sm:py-16">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="space-y-6"
        >
          {/* Brand */}
          <div className="space-y-3 text-center">
            <div className="inline-flex items-center justify-center rounded-full bg-muted p-3">
              <Wrench className="size-7 text-foreground" />
            </div>
            <div className="space-y-1">
              <h1 className="text-3xl font-bold tracking-tight">Forge</h1>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                An autonomous multi-agent software factory. Spin up a project,
                freeze an architecture, and let agents build it end-to-end.
              </p>
            </div>
          </div>

          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as "login" | "waitlist")}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login" className="gap-1.5">
                <LogIn className="size-4" />
                Login
              </TabsTrigger>
              <TabsTrigger value="waitlist" className="gap-1.5">
                <UserPlus className="size-4" />
                Join Waitlist
              </TabsTrigger>
            </TabsList>

            {/* ---------- Login ---------- */}
            <TabsContent value="login">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Sign in to Forge
                  </CardTitle>
                  <CardDescription>
                    Use your account credentials. New here? Join the waitlist
                    instead.
                  </CardDescription>
                </CardHeader>
                <form onSubmit={handleLogin} className="space-y-4">
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="login-email">Email</Label>
                      <Input
                        id="login-email"
                        type="email"
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="login-password">Password</Label>
                      <Input
                        id="login-password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="••••••••"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                      />
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={loginLoading}
                    >
                      {loginLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <LogIn className="size-4" />
                      )}
                      Sign in
                    </Button>
                  </CardFooter>
                </form>
              </Card>
            </TabsContent>

            {/* ---------- Waitlist ---------- */}
            <TabsContent value="waitlist">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Join the waitlist</CardTitle>
                  <CardDescription>
                    We're rolling out access in waves. Drop your email and
                    we'll let you know when your account is ready.
                  </CardDescription>
                </CardHeader>
                {wlDone ? (
                  <CardContent>
                    <Alert>
                      <CheckCircle2 className="size-4" />
                      <AlertTitle>You're on the waitlist!</AlertTitle>
                      <AlertDescription>
                        We'll email you when your account is ready. Once an
                        admin approves your request, you'll receive credentials
                        to log in.
                      </AlertDescription>
                    </Alert>
                  </CardContent>
                ) : (
                  <form onSubmit={handleWaitlist} className="space-y-4">
                    <CardContent className="space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="wl-email">Email *</Label>
                        <Input
                          id="wl-email"
                          type="email"
                          autoComplete="email"
                          placeholder="you@example.com"
                          value={wlEmail}
                          onChange={(e) => setWlEmail(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="wl-name">Name (optional)</Label>
                        <Input
                          id="wl-name"
                          placeholder="Ada Lovelace"
                          value={wlName}
                          onChange={(e) => setWlName(e.target.value)}
                        />
                      </div>
                    </CardContent>
                    <CardFooter>
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={wlLoading}
                      >
                        {wlLoading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <UserPlus className="size-4" />
                        )}
                        Join Waitlist
                      </Button>
                    </CardFooter>
                  </form>
                )}
              </Card>
            </TabsContent>
          </Tabs>

          {/* Demo quick-login */}
          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="size-4" />
                Try the demo
              </CardTitle>
              <CardDescription>
                Skip the waitlist — explore Forge instantly with pre-seeded demo
                accounts. The demo admin can also approve waitlist entries.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => handleDemo("admin")}
                disabled={!!demoLoading}
                className="justify-start h-auto py-2"
              >
                {demoLoading === "admin" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                <span className="flex flex-col items-start text-left">
                  <span className="text-sm font-medium">Demo Admin</span>
                  <span className="text-[11px] text-muted-foreground">
                    demo.admin@forge.local
                  </span>
                </span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleDemo("user")}
                disabled={!!demoLoading}
                className="justify-start h-auto py-2"
              >
                {demoLoading === "user" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LogIn className="size-4" />
                )}
                <span className="flex flex-col items-start text-left">
                  <span className="text-sm font-medium">Demo User</span>
                  <span className="text-[11px] text-muted-foreground">
                    demo.user@forge.local
                  </span>
                </span>
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </main>
      <AuthFooter />
    </div>
  );
}
