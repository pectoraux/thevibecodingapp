"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, signOut } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, LogOut, Users, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

import { apiGet } from "./lib/api";
import type { ProjectDetail } from "./lib/types";
import { useQuery } from "@tanstack/react-query";
import { useForgeStore } from "./lib/store";
import { ProjectList } from "./project-list";
import { ProjectDashboard } from "./project-dashboard";
import { ProvidersModal } from "./providers-modal";
import { AuthScreen } from "./auth-screen";
import { WaitlistPanel } from "./waitlist-panel";

function ForgeFooter() {
  const projectId = useForgeStore((s) => s.selectedProjectId);
  // cheap count via the projects list when on the list screen
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<{ projects: { id: string }[] }>("/api/projects"),
    enabled: !projectId,
    staleTime: 10_000,
  });
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      apiGet<{ project: ProjectDetail }>(`/api/projects/${projectId}`),
    enabled: !!projectId,
    staleTime: 5_000,
  });

  let detail = "Powered by Forge";
  if (projectId && projectQ.data?.project) {
    detail = `Project · ${projectQ.data.project.name}`;
  } else if (!projectId) {
    const n = projectsQ.data?.projects?.length ?? 0;
    detail = `${n} project${n === 1 ? "" : "s"} · Powered by Forge`;
  }

  return (
    <footer className="mt-auto border-t bg-card/50 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Wrench className="size-3.5" />
          Forge
        </span>
        <span className="truncate">{detail}</span>
      </div>
    </footer>
  );
}

// Sticky top bar with auth context: brand + (admin) Waitlist button +
// user email/role badge + Logout button. Rendered above the project list /
// dashboard so it is always visible while authenticated.
function ForgeTopBar() {
  const user = useForgeStore((s) => s.user);
  const setUser = useForgeStore((s) => s.setUser);
  const { toast } = useToast();
  const [wlOpen, setWlOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  if (!user) return null;
  const isAdmin = user.role === "ADMIN" || user.role === "DEMO_ADMIN";

  async function handleLogout() {
    setSigningOut(true);
    try {
      await signOut({ redirect: false });
      const res = await apiGet<{ user: any | null }>("/api/auth/me");
      setUser(res.user ?? null);
      toast({ title: "Signed out" });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-12 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Wrench className="size-4" />
            <span className="hidden sm:inline">Forge</span>
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">DEV MODE</span>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWlOpen(true)}
              >
                <Users className="size-3.5" />
                <span className="hidden sm:inline">Waitlist</span>
              </Button>
            )}
            <div className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs max-w-[180px] sm:max-w-[240px]">
              <span className="font-medium truncate" title={user.email}>
                {user.email}
              </span>
              <Badge
                variant="outline"
                className="px-1 py-0 text-[10px] uppercase shrink-0"
              >
                {user.role.replace("_", " ")}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              disabled={signingOut}
            >
              {signingOut ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogOut className="size-3.5" />
              )}
              <span className="hidden sm:inline">Logout</span>
            </Button>
          </div>
        </div>
      </header>
      {isAdmin && (
        <WaitlistPanel open={wlOpen} onOpenChange={setWlOpen} />
      )}
    </>
  );
}

function ForgeShell() {
  const selectedProjectId = useForgeStore((s) => s.selectedProjectId);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <ForgeTopBar />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedProjectId ?? "list"}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {selectedProjectId ? (
              <ProjectDashboard projectId={selectedProjectId} />
            ) : (
              <ProjectList />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <ForgeFooter />
      <ProvidersModal />
    </div>
  );
}

// Probes /api/auth/me on mount. While checking, shows a full-screen spinner.
// If no user is returned, renders <AuthScreen />. Otherwise renders the
// existing ForgeShell.
function AuthGate() {
  const setUser = useForgeStore((s) => s.setUser);
  const user = useForgeStore((s) => s.user);
  const [checking, setChecking] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ user: any | null }>("/api/auth/me");
        if (!cancelled) setUser(res.user ?? null);
      } catch {
        // network or 5xx — leave user null; AuthScreen will let them retry
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Wrench className="size-6 animate-pulse" />
          <Loader2 className="size-5 animate-spin" />
          <span className="text-xs">Loading Forge…</span>
        </div>
      </div>
    );
  }

  if (!user) return <AuthScreen />;
  return <ForgeShell />;
}

export function ForgeApp() {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 5_000,
          },
        },
      })
  );

  return (
    <SessionProvider>
      <QueryClientProvider client={client}>
        <AuthGate />
      </QueryClientProvider>
    </SessionProvider>
  );
}
