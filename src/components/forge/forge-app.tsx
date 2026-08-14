"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Wrench } from "lucide-react";

import { useForgeStore } from "./lib/store";
import { ProjectList } from "./project-list";
import { ProjectDashboard } from "./project-dashboard";
import { ProvidersModal } from "./providers-modal";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./lib/api";
import type { ProjectDetail } from "./lib/types";

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

function ForgeShell() {
  const selectedProjectId = useForgeStore((s) => s.selectedProjectId);

  return (
    <div className="flex min-h-screen flex-col bg-background">
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
    <QueryClientProvider client={client}>
      <ForgeShell />
    </QueryClientProvider>
  );
}
