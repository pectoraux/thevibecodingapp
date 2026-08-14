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

---
Task ID: v3-api-auth
Agent: api-auth-subagent
Task: Add authentication and multi-tenancy to all API routes

Work Log:
- Read worklog.md, src/lib/auth.ts (requireUserId/requireUserRole/isAdmin/getSession), prisma/schema.prisma (User/Project.userId/LlmProvider.userId/WaitlistEntry), and src/app/api/_lib.ts (readJsonBody, parse* helpers).
- Read every existing route under src/app/api/ to inventory the auth surface (26 existing files + root /api/route.ts stub).
- Modified /api/providers (GET/POST): require userId; GET/POST scoped by `where: { userId }`; POST includes userId in create data; the "unset previous default" updateMany is also scoped to the user so admins can't clobber other users' defaults.
- Modified /api/providers/[id] (DELETE): require userId; verify provider.userId === userId before deleting (403 on mismatch).
- Modified /api/projects (GET/POST): require userId; GET scoped by `where: { userId }`; POST includes userId in create data.
- Modified /api/projects/[id] (GET/PATCH/DELETE): require userId; fetch project, return 404 if missing OR if project.userId !== userId (single uniform check).
- Modified all project-scoped sub-resource routes with the same pattern: fetch the parent project, 404 if missing or not owned by the user, then proceed. This covers:
  • /api/projects/[id]/architecture (GET)
  • /api/projects/[id]/architecture/generate (POST)
  • /api/projects/[id]/architecture/freeze (POST)
  • /api/projects/[id]/architecture/changes (GET, POST)
  • /api/projects/[id]/adrs (GET)
  • /api/projects/[id]/credentials (GET) and /credentials/[credId] (PATCH)
  • /api/projects/[id]/preflight (POST)
  • /api/projects/[id]/tasks (GET), /tasks/[taskId] (GET), /tasks/[taskId]/retry (POST)
  • /api/projects/[id]/agents (GET) and /agents/assign (POST)
  • /api/projects/[id]/github/connect (POST)
  • /api/projects/[id]/repository (GET) and /repository/files (GET)
  • /api/projects/[id]/events (GET)
  • /api/projects/[id]/build (POST) and /build/status (GET)
  • /api/projects/[id]/verification (GET) and /verification/run (POST)
- For /api/projects/[id]/agents/assign (POST): added an explicit check that the body's `providerId` (when provided) belongs to the authenticated user — 403 if prov.userId !== userId. This prevents cross-tenant provider assignment.
- For /api/projects/[id]/credentials/[credId] (PATCH): added a project-ownership check (project belongs to user) BEFORE mutating the credential, since the credential is reached via the project URL.
- Locked down the leftover /api root stub (was `Hello, world!`) to require auth as well.
- Did NOT touch /api/auth/[...nextauth]/route.ts (NextAuth handler) or /api/health/route.ts (public health check) per the rules.
- Did NOT modify any files under src/lib/, src/components/, or prisma/schema.prisma.
- Created new public endpoint /api/auth/signup (POST): validates email, returns 409 if email already in WaitlistEntry OR already in User, otherwise creates a PENDING WaitlistEntry. Returns 201 `{ ok: true, message: "Added to waitlist" }`.
- Created /api/auth/me (GET): uses getSession() to return `{ user: { id, email, name, role, isDemo } | null }`. Public (returns null when logged out rather than 401, so the frontend can probe session state cleanly).
- Created /api/waitlist (GET, ADMIN only): returns all waitlist entries newest-first as `{ entries }`. Uses requireUserRole() + ADMIN/DEMO_ADMIN check, 403 otherwise.
- Created /api/waitlist/[entryId]/approve (POST, ADMIN only): accepts optional `{ password }` (>=8 chars; auto-generates a 12-char random one if missing/weak). Hashes with bcrypt (12 rounds). Creates a User (role=USER, isDemo=false) from the waitlist email/name. Updates the WaitlistEntry to APPROVED with convertedUserId, reviewedAt, reviewedBy (admin's userId). Returns 201 `{ user: { id, email, name }, password }` — the password is returned ONCE for out-of-band sharing. Handles the race-condition where a User with that email already exists by linking the entry and returning 200 with password=null + a note.
- Created /api/waitlist/[entryId]/reject (POST, ADMIN only): updates status to REJECTED, sets reviewedAt + reviewedBy. Returns `{ entry }`.
- Created /api/admin/stats (GET, ADMIN only): aggregates counts — totalUsers, totalProjects, totalProviders, waitlist.{pending,approved,rejected}, totalTasks, totalCommits, totalFiles — via Promise.all of db.count calls.
- Verified the relative-import depth for every modified/created route matches the existing pattern (e.g. ../../../../_lib for /projects/[id]/credentials/[credId]/route.ts, ../../../_lib for /waitlist/[entryId]/approve/route.ts, ../../_lib for /auth/signup/route.ts). Caught and fixed one off-by-one path in the waitlist approve route before saving.
- Verified via Grep that all 31 non-exempt route files now import requireUserId/requireUserRole/getSession; the only file under /api/auth that lacks those imports is the NextAuth handler (correctly exempt) and the public signup route (correctly public).
- Verified dev.log shows no compile errors and the homepage continues to render 200s while the modified routes are JIT-compiled on first request.

Stage Summary:
- Routes modified (existing 27 endpoints across 26 files + root /api stub):
  • /api (GET)
  • /api/providers (GET, POST), /api/providers/[id] (DELETE)
  • /api/projects (GET, POST), /api/projects/[id] (GET, PATCH, DELETE)
  • /api/projects/[id]/architecture (GET), /generate (POST), /freeze (POST), /changes (GET, POST)
  • /api/projects/[id]/adrs (GET)
  • /api/projects/[id]/credentials (GET), /credentials/[credId] (PATCH)
  • /api/projects/[id]/preflight (POST)
  • /api/projects/[id]/tasks (GET), /tasks/[taskId] (GET), /tasks/[taskId]/retry (POST)
  • /api/projects/[id]/agents (GET), /agents/assign (POST)
  • /api/projects/[id]/github/connect (POST)
  • /api/projects/[id]/repository (GET), /repository/files (GET)
  • /api/projects/[id]/events (GET)
  • /api/projects/[id]/build (POST), /build/status (GET)
  • /api/projects/[id]/verification (GET), /verification/run (POST)
- New routes created (7 endpoints across 6 files):
  • /api/auth/signup (POST) — public, adds email to waitlist
  • /api/auth/me (GET) — returns session user or null
  • /api/waitlist (GET) — ADMIN: list waitlist entries
  • /api/waitlist/[entryId]/approve (POST) — ADMIN: create User, return password once
  • /api/waitlist/[entryId]/reject (POST) — ADMIN: mark entry rejected
  • /api/admin/stats (GET) — ADMIN: aggregate platform counts
- Key decisions:
  • All project-scoped routes use a uniform 404 (NOT 403) on missing-or-not-owned to avoid leaking the existence of other users' project IDs (same for providers — 404 on not-found, 403 only on the explicit delete-mismatch case where the resource exists but is owned by someone else).
  • /api/auth/me returns 200 with `{ user: null }` when logged out (not 401) so the frontend can probe session state in a single round-trip without try/catch.
  • /api/auth/signup is intentionally public — anyone landing on the platform can request access without first being logged in.
  • The waitlist approve endpoint returns the auto-generated password exactly once (HTTP 201); the admin is expected to share it with the user out-of-band. Subsequent calls would 409 because the entry is already APPROVED.
  • bcrypt with 12 rounds matches the existing auth.ts Credentials provider convention.
  • Provider "default singleton" is now scoped per-user (the updateMany that clears the previous default is filtered by userId), so each tenant can have their own default provider without interference.
  • All existing functionality (JSON pre-parsing, orchestrator calls, ensureBuildEvent emits, initRepository, readiness gate) is preserved — the auth layer is purely additive.
- Did NOT run `bun run lint` or `bun run build` per instructions; orchestrator will lint after.

---
Task ID: v4-auth-ui
Agent: auth-ui-subagent
Task: Build auth UI (login, signup→waitlist, demo quick-login, admin waitlist panel, user badge+logout)

Work Log:
- Read worklog.md (v3-api-auth + prior stages), src/components/forge/{forge-app.tsx,project-list.tsx,project-dashboard.tsx}, lib/{store,api,format,types}.ts, src/lib/auth.ts, src/app/layout.tsx, hooks/use-toast.ts, and the shadcn/ui {dialog,sheet,tabs,table,toaster} components to ground the implementation in the existing patterns (sticky footer, TanStack Query, Zustand store, toast helper, neutral palette).
- Updated src/components/forge/lib/store.ts: added ForgeUser interface `{ id, email, name?, role, isDemo }` and a `user: ForgeUser | null` field + `setUser` setter to the Zustand store. Mirrors the shape returned by GET /api/auth/me.
- Created src/components/forge/auth-screen.tsx: the landing screen for logged-out visitors. Renders Forge branding (Wrench icon + name + tagline), a Tabs component with two modes (Login, Join Waitlist), and a prominent dashed demo-quick-login card with two buttons (Demo Admin / Demo User) showing each demo email inline.
  • Login mode: email + password form, calls `signIn("credentials", { email, password, redirect: false })` from next-auth/react. On success refetches GET /api/auth/me and pushes the user into the Zustand store. On error shows a destructive toast ("Invalid email or password.").
  • Join Waitlist mode: email + optional name form, calls `POST /api/auth/signup`. On success replaces the form with an Alert ("You're on the waitlist! We'll email you when your account is ready.") and toasts the same message.
  • Demo quick-login: each button calls `signIn("credentials", ...)` with the seeded demo credentials (demo.admin@forge.local / demo-admin-2024, demo.user@forge.local / demo-user-2024), then refetches /api/auth/me. Buttons show a spinner while in flight and are disabled during the round-trip.
  • Layout: `min-h-screen flex flex-col` + sticky footer at the bottom (mt-auto), centered max-w-md card on desktop, full-width on mobile. Footer brand matches the dashboard footer.
- Created src/components/forge/waitlist-panel.tsx: an admin-only Dialog opened from the top bar.
  • Stats row: GET /api/admin/stats → 4 StatCards (Users, Projects, Pending, Approved) with skeletons while loading.
  • Waitlist table: GET /api/waitlist → Table of entries with email (mono), name, status Badge (amber PENDING / emerald APPROVED / rose REJECTED), relative requestedAt, and action buttons.
  • For PENDING rows: Approve (outline, opens a sub-ApproveDialog) + Reject (ghost, calls POST /api/waitlist/[id]/reject).
  • ApproveDialog: optional custom password input (min 8 chars enforced, leave blank to auto-generate). Calls POST /api/waitlist/[id]/approve. On success swaps to a result view showing a read-only copyable password field (with Copy button + navigator.clipboard) and an Alert ("Account created for {email}"). Toasts "Account created for {email}". Handles the race-condition response (password=null) by showing a note that the account was already linked.
  • Uses TanStack Query (useQuery + useMutation) for both lists + mutations; invalidates `["waitlist"]` and `["admin-stats"]` after each approve/reject.
- Modified src/components/forge/forge-app.tsx:
  • Wrapped the app in `<SessionProvider>` from next-auth/react (required for client-side signIn/signOut + CSRF handling). SessionProvider sits outside QueryClientProvider.
  • Added an AuthGate component: on mount, calls GET /api/auth/me and pushes the result into the Zustand store via setUser. While checking, renders a full-screen loading state (Wrench icon + spinner + "Loading Forge…"). If no user, renders <AuthScreen />; otherwise renders <ForgeShell />.
  • Added a ForgeTopBar component rendered at the top of ForgeShell (sticky, z-30, border-b, backdrop-blur). Left: Forge brand (icon + name). Right: Waitlist button (only when user.role is ADMIN or DEMO_ADMIN), a compact user badge (email + uppercase role badge in a bordered pill), and a Logout ghost button. Logout calls `signOut({ redirect: false })` then refetches /api/auth/me and updates the store, toasting "Signed out".
  • Kept the existing ForgeShell structure (AnimatePresence between ProjectList / ProjectDashboard, ForgeFooter with mt-auto, ProvidersModal) intact — the top bar is purely additive.
  • Removed the now-unused `ProjectDetail` import warning by keeping the existing usage in ForgeFooter unchanged.
- Verified against the live dev server: GET / returns 200, GET /api/auth/me returns 200, POST /api/auth/callback/credentials returns 200 (login round-trip works end-to-end), and no compile errors are emitted in dev.log. The AuthGate spinner shows on first load, then transitions to either AuthScreen (logged out) or ForgeShell (logged in).
- Did NOT modify any API routes, src/lib/* files, or prisma/schema.prisma. Did NOT run lint or build per instructions.

Stage Summary:
- Files created: src/components/forge/auth-screen.tsx, src/components/forge/waitlist-panel.tsx.
- Files modified: src/components/forge/forge-app.tsx (SessionProvider + AuthGate + ForgeTopBar), src/components/forge/lib/store.ts (ForgeUser + user/setUser).
- Key decisions:
  • SessionProvider wraps the whole app at the ForgeApp root — required for next-auth/react's signIn/signOut to handle CSRF + session refresh correctly.
  • AuthGate is a single effect that probes /api/auth/me once on mount; subsequent login/logout flows explicitly refetch /api/auth/me and push the result into the store so the gate re-renders without a full page reload.
  • The top bar is global (always visible while authenticated) rather than wedged into the existing per-page headers — this keeps the user badge + logout + Waitlist button discoverable on both the project list and the dashboard without modifying project-list.tsx or project-dashboard.tsx.
  • WaitlistPanel is only rendered for ADMIN/DEMO_ADMIN (the Waitlist button is conditionally shown; the panel itself is also guarded inside ForgeTopBar).
  • Approve flow returns the generated password exactly once and renders a copyable field with a Copy button; the password is never stored client-side beyond the dialog lifecycle.
  • Demo quick-login is intentionally prominent (dashed border card, both demo emails shown inline) so reviewers can explore Forge instantly without joining the waitlist.
  • Color: neutral shadcn palette throughout (background, muted, border, foreground). Status badges use semantic amber/emerald/rose accents only inside the waitlist table — no indigo/blue primary. Sticky footer pattern preserved (min-h-screen flex flex-col + mt-auto) on both AuthScreen and ForgeShell.
- Did NOT run `bun run lint` or `bun run build` per instructions; orchestrator will lint after.
