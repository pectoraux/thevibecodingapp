"use client";

import { create } from "zustand";

export type ForgeTab =
  | "overview"
  | "architecture"
  | "tasks"
  | "agents"
  | "repository"
  | "verification"
  | "credentials"
  | "build-log";

// The authenticated viewer. Mirrors the shape returned by GET /api/auth/me.
export interface ForgeUser {
  id: string;
  email: string;
  name?: string;
  role: string;
  isDemo: boolean;
}

interface ForgeState {
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;

  activeTab: ForgeTab;
  setActiveTab: (tab: ForgeTab) => void;

  // bumping refreshKey invalidates react-query caches that depend on it
  refreshKey: number;
  triggerRefresh: () => void;

  providersModalOpen: boolean;
  setProvidersModalOpen: (open: boolean) => void;

  // current authenticated user (null while checking or logged out)
  user: ForgeUser | null;
  setUser: (user: ForgeUser | null) => void;
}

export const useForgeStore = create<ForgeState>((set) => ({
  selectedProjectId: null,
  setSelectedProjectId: (id) =>
    set({ selectedProjectId: id, activeTab: "overview" }),

  activeTab: "overview",
  setActiveTab: (tab) => set({ activeTab: tab }),

  refreshKey: 0,
  triggerRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),

  providersModalOpen: false,
  setProvidersModalOpen: (open) => set({ providersModalOpen: open }),

  user: null,
  setUser: (user) => set({ user }),
}));
