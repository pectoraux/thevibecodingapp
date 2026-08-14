# Forge — API Contract (shared between backend + frontend subagents)

Base URL: all routes are relative Next.js App Router API routes under `src/app/api/`.

All responses are JSON. Errors return `{ error: string }` with appropriate HTTP status.

## LLM Providers (BYOK)

### `GET /api/providers`
Returns: `{ providers: LlmProvider[] }`
Each provider: `{ id, name, provider, model, capabilities: string[], contextWindow, pricingPer1kInput, pricingPer1kOutput, isDefault, createdAt }`
Note: `apiKey` is NEVER returned.

### `POST /api/providers`
Body: `{ name, provider, model, apiKey, capabilities?: string[], contextWindow?, pricingPer1kInput?, pricingPer1kOutput?, isDefault? }`
Returns: `{ provider: LlmProvider }`
Side effect: obfuscates apiKey before storing.

### `DELETE /api/providers/[id]`
Returns: `{ ok: true }`

### `POST /api/projects/[id]/agents/assign`
Body: `{ agentType, providerId }`
Returns: `{ assignment: AgentAssignment }`
Side effect: upserts AgentAssignment for the given agentType on this project.

## Projects

### `GET /api/projects`
Returns: `{ projects: Project[] }` (newest first)
Project shape: `{ id, name, description, status, githubConnected, githubRepo, createdAt, updatedAt, _count?: { tasks, credentials } }`

### `POST /api/projects`
Body: `{ name, description, productSpec, requirements, stack }`
Returns: `{ project: Project }`
Side effect: creates project in DRAFT status, initializes empty repository (calls `initRepository`).

### `GET /api/projects/[id]`
Returns: `{ project: Project, architecture?: Architecture, counts: { tasks, completedTasks, failedTasks, agents, credentials, configuredCredentials, commits, files, events } }`

### `PATCH /api/projects/[id]`
Body: partial of `{ name, description, productSpec, requirements, stack }`
Returns: `{ project: Project }`

### `DELETE /api/projects/[id]`
Returns: `{ ok: true }`

## Architecture

### `POST /api/projects/[id]/architecture/generate`
Returns: `{ architecture: Architecture }`
Side effect: calls `runArchitect(projectId)`. May take 10-30 seconds. Sets status to AWAITING_ARCHITECTURE_APPROVAL.
Architecture shape: `{ id, projectId, version, hash, frozen, frozenAt, contractJson, contractMd, components: any[], dataModels: any[], apiContracts: any[], integrations: any[], invariants: string[], constraints: string[], testingStrategy: any, deploymentModel: any, createdAt }`
NOTE: `components`, `dataModels`, etc. are JSON.parse'd already in the response (so frontend gets arrays/objects, not strings).

### `GET /api/projects/[id]/architecture`
Returns: `{ architecture: Architecture | null }` (same shape, fields pre-parsed)

### `POST /api/projects/[id]/architecture/freeze`
Returns: `{ architecture: Architecture }`
Side effect: calls `freezeArchitecture`. Sets status to ARCHITECTURE_FROZEN.

### `GET /api/projects/[id]/architecture/changes`
Returns: `{ changeRequests: ArchitectureChangeRequest[] }`

### `POST /api/projects/[id]/architecture/changes`
Body: `{ title, problem, affectedComponents, proposedChange, rationale, risks, migrationRequirements, affectedTests, affectedApis, affectedDependencies, estimatedImpact }`
Returns: `{ changeRequest: ArchitectureChangeRequest }`

### `GET /api/projects/[id]/adrs`
Returns: `{ adrs: Adr[] }`

## Credentials

### `GET /api/projects/[id]/credentials`
Returns: `{ credentials: Credential[] }`
Credential shape: `{ id, name, purpose, environment, provider, required, optional, configured, validated, testSandboxSupport, whenRequired, validationMethod }`
NOTE: `value` is NEVER returned.

### `PATCH /api/projects/[id]/credentials/[credId]`
Body: `{ value, environment? }`
Returns: `{ credential: Credential }`
Side effect: obfuscates value, marks configured=true, validated=true (basic non-empty check).

### `POST /api/projects/[id]/preflight`
Returns: `{ preflight: PreflightResult }` = `{ passed, total, configured, missing: [{name, purpose, whenRequired}] }`

## Tasks

### `GET /api/projects/[id]/tasks`
Returns: `{ tasks: Task[] }`
Task shape: `{ id, code, title, description, component, agentType, dependencies: string[], acceptanceCriteria: string[], requiredTests: string[], priority, risk, status, attempts, maxAttempts, assignedModel, reviewStatus, architectureStatus, readinessStatus, branchName, commitSha, filesChanged: string[], testResults: any[], guardianResult?: any, reviewResult?: any, failureReason, blockedReason, startedAt, completedAt, createdAt, updatedAt }`
NOTE: JSON fields are pre-parsed in the response.

### `GET /api/projects/[id]/tasks/[taskId]`
Returns: `{ task: Task }` (same shape, with `implementationLog` and full guardian/review results)

### `POST /api/projects/[id]/tasks/[taskId]/retry`
Returns: `{ task: Task }`
Side effect: resets task status to PLANNED, clears failureReason.

## Agents

### `GET /api/projects/[id]/agents`
Returns: `{ agents: (AgentAssignment & { provider?: LlmProvider | null })[] }`
AgentAssignment shape: `{ id, agentType, providerId, provider?, state, currentTaskId, lastActivity, tokensUsed, costUsd }`

## GitHub / Repository

### `POST /api/projects/[id]/github/connect`
Body: `{ repoName }`
Returns: `{ project: Project }`
Side effect: sets githubConnected=true, githubRepo=repoName, calls `initRepository` if not already initialized.

### `GET /api/projects/[id]/repository`
Returns: `{ branches: RepoBranch[], commits: RepoCommit[], files: RepoFile[], pullRequests: PullRequest[] }`
File shape includes `suspiciousPatterns: string[]` (pre-parsed).

### `GET /api/projects/[id]/repository/files?path=...`
Query: `path` (file path)
Returns: `{ file: RepoFile }`

## Build

### `POST /api/projects/[id]/build`
Returns: `{ project: Project }`
Side effect: calls `startBuild(projectId)`. This is the big one — runs the full autonomous loop. May take 1-5 minutes. Should be awaited (frontend shows loading then refreshed state).

### `GET /api/projects/[id]/build/status`
Returns: `{ status: ProjectStatus, totalTasks, completedTasks, failedTasks, currentTask?: Task, recentEvents: BuildEvent[] }`

## Verification

### `GET /api/projects/[id]/verification`
Returns: `{ checks: ReadinessCheck[], passed, total, passedCount, failedCount }`
ReadinessCheck shape: `{ id, category, name, description, required, status, evidence: any, failureReason, checkedAt }`

### `POST /api/projects/[id]/verification/run`
Returns: `{ result: { passed, total, passedCount, failedCount, results: any[] } }`
Side effect: calls `runReadinessGate`.

## Events (audit log)

### `GET /api/projects/[id]/events?limit=200`
Returns: `{ events: BuildEvent[] }`
BuildEvent shape: `{ id, type, level, message, taskId, agentType, payload: any, createdAt }`
NOTE: payload is pre-parsed if present.

## Health

### `GET /api/health`
Returns: `{ ok: true, ts: number }`
