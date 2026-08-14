"use client";

// Forge — shared frontend type aliases derived from the API contract.
// These mirror the backend domain types but only the fields the UI needs.
// Keeping them loose (`any`/`unknown` for pre-parsed JSON) avoids coupling
// to internal Prisma shapes that the backend may evolve independently.

import type { ProjectStatus, TaskStatus, AgentType } from "@/lib/types";

export interface LlmProvider {
  id: string;
  name: string;
  provider: string;
  model: string;
  capabilities?: string[];
  contextWindow?: number | null;
  pricingPer1kInput?: number | null;
  pricingPer1kOutput?: number | null;
  isDefault?: boolean;
  createdAt?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  status: ProjectStatus;
  githubConnected?: boolean;
  githubRepo?: string | null;
  productSpec?: string | null;
  requirements?: string | null;
  stack?: string | null;
  failureReason?: string | null;
  blockedReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
  _count?: {
    tasks?: number;
    credentials?: number;
  };
}

export interface ProjectDetail extends Project {
  architecture?: Architecture | null;
  counts: {
    tasks: number;
    completedTasks: number;
    failedTasks: number;
    agents: number;
    credentials: number;
    configuredCredentials: number;
    commits: number;
    files: number;
    events: number;
  };
}

export interface Architecture {
  id: string;
  projectId: string;
  version: number;
  hash: string;
  frozen: boolean;
  frozenAt?: string | null;
  contractJson?: unknown;
  contractMd?: string | null;
  components?: any[];
  dataModels?: any[];
  apiContracts?: any[];
  integrations?: any[];
  invariants?: string[];
  constraints?: string[];
  testingStrategy?: any;
  deploymentModel?: any;
  createdAt?: string;
}

export interface ArchitectureChangeRequest {
  id: string;
  title: string;
  problem?: string | null;
  affectedComponents?: any;
  proposedChange?: string | null;
  rationale?: string | null;
  risks?: any;
  migrationRequirements?: any;
  affectedTests?: any;
  affectedApis?: any;
  affectedDependencies?: any;
  estimatedImpact?: string | null;
  status?: string;
  createdAt?: string;
}

export interface Adr {
  id: string;
  title: string;
  status?: string;
  context?: string | null;
  decision?: string | null;
  consequences?: string | null;
  createdAt?: string;
}

export interface Credential {
  id: string;
  name: string;
  purpose?: string | null;
  environment?: string | null;
  provider?: string | null;
  required?: boolean;
  optional?: boolean;
  configured?: boolean;
  validated?: boolean;
  testSandboxSupport?: boolean;
  whenRequired?: string | null;
  validationMethod?: string | null;
}

export interface PreflightResult {
  passed: boolean;
  total: number;
  configured: number;
  missing?: { name: string; purpose?: string | null; whenRequired?: string | null }[];
}

export interface Task {
  id: string;
  code: string;
  title: string;
  description?: string | null;
  component?: string | null;
  agentType: AgentType;
  dependencies?: string[];
  acceptanceCriteria?: string[];
  requiredTests?: string[];
  priority?: string | null;
  risk?: string | null;
  status: TaskStatus;
  attempts?: number;
  maxAttempts?: number;
  assignedModel?: string | null;
  reviewStatus?: string | null;
  architectureStatus?: string | null;
  readinessStatus?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  filesChanged?: string[];
  testResults?: any[];
  guardianResult?: any;
  reviewResult?: any;
  failureReason?: string | null;
  blockedReason?: string | null;
  implementationLog?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentAssignment {
  id: string;
  agentType: AgentType;
  providerId?: string | null;
  provider?: LlmProvider | null;
  state?: string | null;
  currentTaskId?: string | null;
  lastActivity?: string | null;
  tokensUsed?: number;
  costUsd?: number;
}

export interface RepoBranch {
  id: string;
  name: string;
  headSha: string;
  isDefault?: boolean;
}

export interface RepoCommit {
  id: string;
  sha: string;
  branch: string;
  message: string;
  author: string;
  createdAt: string;
  filesChanged?: any[];
}

export interface RepoFile {
  id: string;
  path: string;
  language?: string | null;
  bytes?: number;
  content?: string | null;
  suspiciousPatterns?: string[];
  branch?: string | null;
  commitSha?: string | null;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  createdAt?: string;
}

export interface ReadinessCheck {
  id: string;
  category: string;
  name: string;
  description?: string | null;
  required?: boolean;
  status: string;
  evidence?: any;
  failureReason?: string | null;
  checkedAt?: string | null;
}

export interface BuildEvent {
  id: string;
  type: string;
  level?: string | null;
  message: string;
  taskId?: string | null;
  agentType?: AgentType | null;
  payload?: any;
  createdAt: string;
}

export interface BuildStatus {
  status: ProjectStatus;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  currentTask?: Task | null;
  recentEvents?: BuildEvent[];
}
