# Task 6 — frontend-ui-subagent work record

## Scope
Build the complete Forge dashboard UI as a single-page app at `/`. Backend
routes (Task 4) were implemented in parallel; this agent coded strictly against
`API_CONTRACT.md` and `src/lib/types.ts`.

## Files created
```
src/app/page.tsx                              (overwritten — renders <ForgeApp />)
src/components/forge/forge-app.tsx            (QueryClientProvider + shell + footer)
src/components/forge/project-list.tsx         (list + create dialog)
src/components/forge/project-dashboard.tsx    (tabbed shell + build/long-run overlays)
src/components/forge/providers-modal.tsx      (BYOK providers CRUD)
src/components/forge/status-badge.tsx         (ProjectStatus/TaskStatus/Agent/Readiness badges)
src/components/forge/state-stepper.tsx        (horizontal lifecycle stepper)
src/components/forge/lib/api.ts               (apiGet/Post/Patch/Delete + ApiError)
src/components/forge/lib/store.ts             (Zustand: selectedProjectId, activeTab, refreshKey, providersModalOpen)
src/components/forge/lib/format.ts            (formatTime/Relative/Duration/Cost/Tokens/Bytes + tone palette)
src/components/forge/lib/types.ts             (frontend type aliases mirroring the contract)
src/components/forge/tabs/overview.tsx
src/components/forge/tabs/architecture.tsx
src/components/forge/tabs/tasks.tsx
src/components/forge/tabs/agents.tsx
src/components/forge/tabs/repository.tsx
src/components/forge/tabs/verification.tsx
src/components/forge/tabs/credentials.tsx
src/components/forge/tabs/build-log.tsx
```
Did NOT touch `src/app/api/*`, `src/lib/*`, or `prisma/schema.prisma`.

## Key UX decisions
- **Single shared BYOK modal** controlled by the Zustand store (`providersModalOpen`),
  rendered once in `ForgeShell` so both the list view and dashboard can open it.
- **Long-running overlays**: a non-dismissable `Dialog` (escape/outside-click
  suppressed) wraps architecture generation and the build call so users can’t
  trigger duplicate mutations while the backend is working.
- **Polling via react-query `refetchInterval`**: project detail polls every
  2.5s while `ARCHITECTING/BUILDING/VERIFYING`; build/status polls every 2s
  while `BUILDING/VERIFYING`. Both stop on terminal statuses.
- **Color**: primary palette is the shadcn neutral oklch grays — no indigo/blue
  brand color. Per-agent accents come from `AGENT_META.color` (violet/amber/
  rose/emerald/cyan/orange/slate/fuchsia/blue); blue is only used as the QA
  agent accent, never as the brand.
- **Sticky footer**: `min-h-screen flex flex-col` root + `mt-auto` footer, shows
  project count on the list view and the active project name in the dashboard.
- **Mobile-first**: tab list scrolls horizontally; tables hide non-essential
  columns at `sm`/`md`/`lg` breakpoints; the tasks detail uses a right-side
  `Sheet` that goes full-width on mobile.

## Verification performed (against the live backend)
- `GET /` returns 200 with "Forge" + "New Project" in the SSR HTML.
- `GET /api/health` → `{ok:true}`.
- `POST /api/projects` created a project → 200 with full Project shape.
- `GET /api/projects/[id]` returns `{project, architecture, counts}` ✅ matches.
- `GET tasks/agents/repository/credentials/verification` all → 200 with shapes
  matching the frontend type aliases (empty arrays → empty-state UIs render).
- `DELETE /api/projects/[id]` → `{ok:true}`. Smoke-test project removed; DB clean.

## Gotchas / notes for the orchestrator
- `react-syntax-highlighter` was available but not used — the file viewer uses a
  plain `<pre>` with `bg-muted` + `overflow-auto` per the spec’s “simple”
  option, avoiding an extra bundle.
- The `BuildProgressStrip` (in `project-dashboard.tsx`) reads `build/status`
  to show live task counts while building.
- `AGENTS` tab fetches `/events?limit=50` and client-filters by `agentType` to
  show recent executions per agent (the contract has no per-agent endpoint).
- Some JSON fields (components/dataModels/apiContracts/evidence) are typed as
  `any[]` deliberately so the UI doesn’t couple to internal Prisma shapes.
