# Worklog — Multi-LLM Vibe Coding Platform (Forge)

This file is the shared worklog for all agents working on the autonomous software-building platform.

Project codename: **Forge** — a multi-agent AI software factory.

---
Task ID: 0
Agent: orchestrator (main)
Task: Inspect existing codebase and plan the build.

Work Log:
- Read full 2262-line spec from upload.
- Inspected Next.js 16 scaffold: Tailwind 4, shadcn/ui (New York), Prisma 6 + SQLite, z-ai-web-dev-sdk, react-query, zustand, framer-motion.
- Confirmed dev server already running on port 3000.
- Decided MVP scope: full project lifecycle state machine, BYOK LLM provider abstraction (using z-ai-web-dev-sdk as the real LLM backend), simulated GitHub (DB-backed virtual repo), Architect → Guardian → Reviewer → Implementation agent runtime driven by real LLM calls, Production Readiness Gate with evidence, complete dashboard UI with 7 views.

Stage Summary:
- Foundation phase begins next. Will write Prisma schema, types/enums, LLM client wrapper, then API routes + orchestration engine, then UI.
- All LLM calls go through z-ai-web-dev-sdk on the server.
- Virtual repository is DB-backed (files, branches, commits, PRs) so the platform is fully functional in the sandbox without real GitHub credentials.

---
Task ID: 4
Agent: backend-api-routes-subagent
Task: Implement all Forge backend API routes per API_CONTRACT.md

Work Log:
- Read worklog.md, API_CONTRACT.md, prisma/schema.prisma, src/lib/{types,db,orchestrator,readiness,repo,events,crypto}.ts to ground the implementation in the existing foundation.
- Created src/app/api/_lib.ts with shared helpers: parseJson<T>, readJsonBody, stripProvider (removes apiKey, parses capabilities), parseArchitecture (pre-parses all 8 JSON-string fields), parseTask (pre-parses dependencies, acceptanceCriteria, requiredTests, filesChanged, testResults, guardianResult, reviewResult), stripCredential (removes value), parseRepoFile (suspiciousPatterns), parseRepoCommit (filesChanged), parsePullRequest (commits, files), parseBuildEvent (payload), parseReadinessCheck (evidence), parseAgentAssignment (provider).
- Implemented health route: GET /api/health → { ok, ts }.
- Implemented LLM provider routes: GET/POST /api/providers (POST obfuscates apiKey, parses capabilities array, manages isDefault singleton), DELETE /api/providers/[id]. Never returns apiKey.
- Implemented project routes: GET /api/projects (with _count for tasks & credentials, newest-first), POST /api/projects (creates DRAFT project, emits PROJECT_CREATED event, calls initRepository to seed README+.gitignore). GET /api/projects/[id] returns full project + parsed architecture + counts object (tasks, completedTasks, failedTasks, agents, credentials, configuredCredentials, commits, files, events). PATCH updates editable fields. DELETE relies on Prisma cascade.
- Implemented architecture routes: GET /api/projects/[id]/architecture (returns parsed architecture or null). POST /api/projects/[id]/architecture/generate awaits runArchitect. POST /api/projects/[id]/architecture/freeze awaits freezeArchitecture. GET/POST /api/projects/[id]/architecture/changes (POST creates a new ArchitectureChangeRequest with all 4 JSON-array fields stored as strings, emits CHANGE_REQUEST_CREATED event). GET /api/projects/[id]/adrs.
- Implemented credentials routes: GET /api/projects/[id]/credentials (NEVER returns value). PATCH /api/projects/[id]/credentials/[credId] obfuscates value, sets configured=true, validated=true iff trimmed value is non-empty.
- Implemented preflight: POST /api/projects/[id]/preflight → { preflight: { passed, total, configured, missing: [{name, purpose, whenRequired}] } } via runPreflight.
- Implemented task routes: GET /api/projects/[id]/tasks (sorted by priority/code, JSON fields pre-parsed). GET /api/projects/[id]/tasks/[taskId] includes implementationLog + full guardianResult/reviewResult. POST /api/projects/[id]/tasks/[taskId]/retry resets to PLANNED, clears failureReason/blockedReason, emits TASK_QUEUED.
- Implemented agent routes: GET /api/projects/[id]/agents returns assignments with nested provider (apiKey stripped). POST /api/projects/[id]/agents/assign upserts by (projectId, agentType), validates providerId if given, emits PROVIDER_CONFIGURED event.
- Implemented GitHub + repository routes: POST /api/projects/[id]/github/connect sets githubConnected + githubRepo, calls initRepository only if repo has zero commits (idempotent), emits GITHUB_CONNECTED. GET /api/projects/[id]/repository returns branches, commits (filesChanged pre-parsed), files (suspiciousPatterns pre-parsed), pullRequests (commits/files pre-parsed). GET /api/projects/[id]/repository/files?path=... returns single file with pre-parsed suspiciousPatterns.
- Implemented build routes: POST /api/projects/[id]/build awaits startBuild (1–5 min long-running; frontend shows spinner). GET /api/projects/[id]/build/status returns project status + total/completed/failed task counts + current RUNNING/REVIEWING task + 20 most recent build events.
- Implemented verification routes: GET /api/projects/[id]/verification returns checks + passed/total/passedCount/failedCount summary. POST /api/projects/[id]/verification/run awaits runReadinessGate and returns { result: { passed, total, passedCount, failedCount, results } }.
- Implemented events route: GET /api/projects/[id]/events?limit=200 (capped at 1000), payload pre-parsed.
- Verified all 26 route files (31 endpoints) exist under src/app/api/ and use Next.js 16 async params pattern (const { id } = await params).

Stage Summary:
- Routes created (31 endpoints across 26 files under src/app/api/):
  • /api/health (GET)
  • /api/providers (GET, POST), /api/providers/[id] (DELETE)
  • /api/projects (GET, POST), /api/projects/[id] (GET, PATCH, DELETE)
  • /api/projects/[id]/architecture (GET)
  • /api/projects/[id]/architecture/generate (POST), /freeze (POST), /changes (GET, POST)
  • /api/projects/[id]/adrs (GET)
  • /api/projects/[id]/credentials (GET), /credentials/[credId] (PATCH)
  • /api/projects/[id]/preflight (POST)
  • /api/projects/[id]/tasks (GET), /tasks/[taskId] (GET), /tasks/[taskId]/retry (POST)
  • /api/projects/[id]/agents (GET), /agents/assign (POST)
  • /api/projects/[id]/github/connect (POST)
  • /api/projects/[id]/repository (GET), /repository/files (GET ?path=)
  • /api/projects/[id]/build (POST), /build/status (GET)
  • /api/projects/[id]/verification (GET), /verification/run (POST)
  • /api/projects/[id]/events (GET ?limit=)
- Key decisions:
  • All JSON-string DB fields pre-parsed via parseJson helper before responding (architecture.components, task.dependencies/filesChanged/testResults/guardianResult/reviewResult, repoFile.suspiciousPatterns, repoCommit.filesChanged, pullRequest.commits/files, buildEvent.payload, readinessCheck.evidence).
  • Secrets (LlmProvider.apiKey, Credential.value) NEVER included in any response; providers have apiKey stripped, credentials have value stripped. POST /api/providers obfuscates apiKey; PATCH credentials obfuscates value.
  • Next.js 16 async params pattern used everywhere: `const { id } = await params`.
  • Long-running operations (architecture/generate, build) are awaited synchronously so the frontend can show a spinner.
  • POST /api/projects also calls initRepository so every new project starts with README + .gitignore.
  • POST /api/projects/[id]/github/connect is idempotent — only initializes the repo if it currently has zero commits.
  • POST /api/projects/[id]/agents/assign upserts by (projectId, agentType).
- Gotchas / notes for downstream agents:
  • src/lib/readiness.ts runPreflight() appears to call ensureBuildEvent(projectId, {...}) with two args, but ensureBuildEvent takes a single EmitEventInput object. This is a latent bug in lib/ that the lib/orchestrator agent should fix — preflight runs will currently emit a malformed event (caught by ensureBuildEvent's try/catch and logged to stderr, so it won't crash the API).
  • The default api/route.ts (GET /api → "Hello, world!") was left in place; contract doesn't define a root /api endpoint.
  • POST /api/projects returns 201; POST /api/providers returns 201; POST /api/projects/[id]/architecture/changes returns 201; all other POSTs return 200.
  • No new packages installed. No src/lib/* or prisma/schema.prisma modifications.

---
Task ID: 6
Agent: frontend-ui-subagent
Task: Build Forge dashboard UI with all 8 tabs and BYOK providers modal

Work Log:
- Read API_CONTRACT.md, src/lib/types.ts, globals.css, layout.tsx, and the shadcn/ui component set (card, button, tabs, table, dialog, sheet, select, scroll-area, accordion, skeleton, alert, etc.) to ground the implementation in the existing foundation.
- Created src/components/forge/lib/{api,store,format,types}.ts: fetch helpers (apiGet/Post/Patch/Delete + ApiError), Zustand store (selectedProjectId, activeTab, refreshKey, providersModalOpen), display formatters + centralized tone→class palette, and frontend type aliases mirroring the contract (JSON fields left as any to avoid coupling to Prisma shapes).
- Built status-badge.tsx (ProjectStatus/TaskStatus/AgentState/Readiness tones + AgentBadge keyed off AGENT_META.color + generic ToneBadge) and state-stepper.tsx (horizontal lifecycle visualization using PROJECT_STATUS_ORDER, with off-path terminal states rendered as a standalone chip).
- Built providers-modal.tsx (BYOK): lists configured providers, add-provider form (name/provider/model/apiKey/capabilities multi-select/contextWindow/pricing/isDefault), delete confirmation, zai-sandbox note. Single instance controlled by the store so both list + dashboard can open it.
- Built project-list.tsx (searchable cards with status badge + github + task count + relative time, create dialog with productSpec/requirements/stack) and project-dashboard.tsx (top bar with Start Build gated on ARCHITECTURE_FROZEN/PREFLIGHT, blocked/failed/human-review banners, live build progress strip, 8 Tabs, build confirmation dialog, non-dismissable long-running overlay for the build mutation).
- Built forge-app.tsx: QueryClientProvider wrapper, AnimatePresence route between list/dashboard, sticky footer (mt-auto) showing project count or active project name.
- Built the 8 tabs: overview (state stepper, 8 stat cards, blockers from failed tasks, recent activity scroll-area, 12+1 readiness category grid), architecture (generate/freeze with overlays, components accordion, data-models + api-contracts tables, integrations, Guardian-enforced invariants, ADRs accordion, change-request form, contract-JSON dialog), tasks (filterable table + right-side Sheet detail with test results/guardian/review verdicts/implementation log/retry), agents (grid of all 9 AgentTypes with model/state/tokens/cost, assign-provider dialog, permissions, recent executions), repository (branches, commits table with changed-files dialog, file tree with suspicious-pattern badges + content viewer, PRs), verification (gate banner + grouped checks with collapsible evidence + re-run), credentials (manifest table, set-value dialog with password input + env select, preflight runner, never displays secrets), build-log (live feed with level filter + 2s auto-refresh while building).
- Overwrote src/app/page.tsx to render <ForgeApp />.
- Cleaned up unused imports across all tab files (removed dead lucide icons, unused type aliases, trailing re-export) to keep the lint surface minimal.
- Verified end-to-end against the live backend: GET / returns 200 with Forge SSR HTML; /api/health ok; created + deleted a smoke-test project; confirmed tasks/agents/repository/credentials/verification endpoints all return shapes matching the frontend type aliases (empty arrays render empty-state UIs). Removed the smoke-test project to leave the DB clean.

Stage Summary:
- 18 files created under src/components/forge/ (+ lib/types/format/store/api) and src/app/page.tsx overwritten. No changes to src/app/api/*, src/lib/*, or prisma.
- State: Zustand for client UI state (selected project, active tab, modal open, refresh trigger); TanStack Query for all server state with conditional refetchInterval polling (2–2.5s) while a project is ARCHITECTING/BUILDING/VERIFYING, stopping on terminal statuses.
- UX: long-running architecture-generation and build operations use a non-dismissable Dialog overlay (escape/outside-click suppressed) to prevent duplicate mutations; toasts (useToast) for success/error; skeletons during loads; framer-motion for subtle page/tab transitions; responsive mobile-first layout with horizontally-scrolling tab bar and breakpoint-aware table columns.
- Color: brand uses the shadcn neutral oklch palette (no indigo/blue primary); per-agent accents come from AGENT_META (violet/amber/rose/emerald/cyan/orange/slate/fuchsia/blue — blue only as the QA accent). Sticky footer at the bottom of every screen via min-h-screen flex flex-col + mt-auto.
- Gotchas: react-syntax-highlighter was available but the file viewer uses a plain <pre> per the spec’s “simple” option to avoid an extra bundle; the agents tab client-filters /events?limit=50 by agentType since the contract has no per-agent endpoint; JSON fields are typed as any[] so the UI doesn’t couple to evolving Prisma shapes.

---
Task ID: 7
Agent: orchestrator (main) — end-to-end verification
Task: Verify the full Forge platform works end-to-end via Agent Browser, fix bugs found.

Work Log:
- Fixed two bugs found during verification:
  1. `runPreflight` was not imported in orchestrator.ts → added to import line.
  2. RepoBranch and PullRequest models were missing `@@unique` constraints → added `@@unique([projectId, name])` and `@@unique([projectId, number])`, re-pushed schema.
  3. `src/app/api/providers/route.ts` had wrong relative import `../../_lib` → fixed to `../_lib`.
  4. Cleared stale turbopack cache (.next/) and restarted dev server.
- Ran full end-to-end flow via Agent Browser:
  1. Created "Task Tracker MVP" project with product spec, requirements, stack.
  2. Architect LLM generated architecture: 6 components (Frontend, Backend, Database, Infrastructure, Payment Integration, QA), 3 data models, API contracts, 3 required credentials, ADRs, 10-task graph with dependencies.
  3. User reviewed architecture (Components accordion, data models table, API contracts, invariants, ADRs).
  4. Froze architecture → status ARCHITECTURE_FROZEN, hash b3fe39b.
  5. Connected GitHub (simulated) → repo initialized with README + .gitignore on main branch.
  6. Set 2 required credentials (DATABASE_URL, JWT_SECRET) via UI/API.
  7. Ran preflight → PASSED (2/2 configured).
  8. Pressed Start Build → autonomous loop ran.
- Autonomous build loop executed:
  - Implementation agents produced REAL code: 28 files across 12 commits (package.json, prisma/schema.prisma, Next.js app structure, Dockerfile, .env.example, API routes, components, tests).
  - Tests ran with evidence (e.g. 11/15 passed, 10/11 passed).
  - Architecture Guardian flagged VIOLATIONS (e.g. "Must use SQLite via Prisma" — implementation introduced Firebase/Stripe not in frozen contract; "No mocks in production code paths" — hardcoded placeholder price ID).
  - Independent Code Reviewer requested CHANGES_REQUESTED with specific findings (security/critical: hardcoded price ID; api_correctness/high: endpoints not in frozen contract).
  - Repair loop retried failed tasks up to 3 attempts.
  - 4 tasks exhausted retries → FAILED. 6 tasks remained PLANNED (blocked by failed dependencies).
  - Platform escalated to HUMAN_REVIEW_REQUIRED (did NOT claim production-ready).
- Production Readiness Gate ran with 14 evidence-based checks across 12 categories:
  - 10 PASSED: BUILD (files present, package.json), STATIC (no high-severity fake patterns), DATA (schema defined), AUTH (auth implemented), ERRORS (error handling present), OBSERVABILITY (health endpoint), SECURITY (no committed secrets), CONFIG (.env.example), DEPLOYMENT (Dockerfile exists), INTEGRATIONS (credentials configured for declared integrations).
  - 4 FAILED: TESTS (tasks not all completed), TESTS (some tests failing), RUNTIME (no application entrypoint), INTEGRATIONS (Stripe credential not configured).
  - Platform refused PRODUCTION_READY and provided specific failure reasons.
- Verified UI across all 8 tabs: Overview (state stepper, stat cards, readiness grid), Architecture (components/data-models/API/invariants/ADRs/change-requests), Tasks (task graph with status/agent/attempts/deps + detail dialog with guardian/review evidence), Agents (9-agent grid), Repository (branches/commits/files with suspicious-pattern badges), Verification (gate banner + grouped checks with evidence), Credentials (manifest + set-value dialog), Build Log (live event feed).
- Verified sticky footer: short page (project list) → footer at viewport bottom (536/577px); long page (dashboard) → footer pushed to document bottom (880/921px). No overlay, no gap.
- Verified responsive: tabs scroll horizontally on mobile; tables adapt; dialogs full-width on mobile.

Stage Summary:
- Platform is FULLY FUNCTIONAL end-to-end. Every major spec requirement is demonstrated:
  - Multi-agent orchestration with real LLM calls (z-ai-web-dev-sdk)
  - Architecture Contract generation + freeze + Guardian enforcement
  - Independent code review (skeptical, evidence-based)
  - Autonomous repair loop with bounded retries
  - Production Readiness Gate that refuses to declare ready without evidence
  - Failure transparency (specific blockers, not vague claims)
  - Fake Implementation Detector (caught TODO in prisma schema, hardcoded price ID)
  - BYOK provider abstraction (z-ai default + OpenAI-compatible adapter)
  - Virtual GitHub (DB-backed branches/commits/files/PRs)
  - Full dashboard UI with 8 tabs + BYOK providers modal
- Lint passes (0 errors, 8 cosmetic warnings about unused eslint-disable directives).
- Dev server running cleanly on port 3000.
- 19 screenshots saved to /home/z/my-project/screenshots/ documenting the full flow.
