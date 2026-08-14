# Forge Phase 2 Audit — Simulation vs Reality

This document audits the current Forge implementation against the Phase 2 specification.
It explicitly identifies every simulated system that must be replaced.

## Audit Date: Phase 2 start

---

## SIMULATED (must be replaced in P0)

### 1. GitHub / Repository — DB-BACKED SIMULATION ❌
**Current**: `src/lib/repo.ts` stores files, branches, commits as DB rows. No real git operations.
**Required**: Real GitHub API + real git clone/push/worktree. Git is canonical, DB is metadata.
**Impact**: Repository view shows DB rows, not real git state. No real branches, no real PRs.

### 2. Test Execution — SOURCE-CONTENT HEURISTIC ❌
**Current**: `runTaskTests()` in orchestrator.ts checks if keywords appear in file content. Does not execute tests.
**Required**: Real test runner that executes `npm test` / `pytest` / `go test` etc and parses exit codes + output.
**Impact**: "Tests passed" is a lie. No real evidence.

### 3. LLM Fallback — TEMPLATE ADAPTER ❌
**Current**: `ZaiAdapter` falls back to `TemplateAdapter` when z-ai-web-dev-sdk is unavailable. On Vercel, ALL agent calls use templates but are labeled as successful.
**Required**: No template fallback in production. LLM unavailable → BLOCKED.
**Impact**: Platform appears to work on Vercel but generates no real LLM output.

### 4. Secret Storage — REVERSIBLE XOR ❌
**Current**: `src/lib/crypto.ts` uses XOR + base64. `FORGE_SECRET` has a hardcoded default.
**Required**: AES-256-GCM encryption with master key from infrastructure. No default key in production.
**Impact**: Credentials are not securely stored.

### 5. Readiness Gate — HEURISTIC CHECKS ❌
**Current**: `src/lib/readiness.ts` checks if files exist, if keywords appear in content. Does not build or run the product.
**Required**: Executable verification plan — real build, real tests, real runtime startup, real health checks.
**Impact**: "Production ready" is meaningless.

### 6. Guardian — LLM-ONLY ❌
**Current**: `runGuardian()` sends files to LLM and trusts its verdict.
**Required**: Layer 1 deterministic checks (package.json diff, forbidden tech, schema changes) + Layer 2 semantic LLM.
**Impact**: Architecture drift is not reliably detected.

### 7. Code Review — LLM-ONLY, NOT INDEPENDENT ❌
**Current**: `runCodeReview()` sends files to LLM. Reviewer sees implementation agent's output.
**Required**: Reviewer receives actual git diff + test evidence, not implementation description.
**Impact**: Review is not truly independent.

### 8. Fake Implementation Detector — STRING MATCHING ONLY ❌
**Current**: Scans for "TODO", "mock", "stub" keywords. Treats all occurrences as suspicious.
**Required**: Combine static scan + dependency analysis + call-graph + tests + LLM review. Mocks in tests are valid.
**Impact**: False positives on legitimate test code; misses real fakes.

---

## REAL (keep and improve)

### ✓ Project state machine — real enum-based transitions
### ✓ Architecture contract — real structured JSON with version + hash
### ✓ Architecture freeze — real immutable flag
### ✓ ADR system — real records
### ✓ Task graph — real dependency-aware execution
### ✓ Agent roles — real 9-role model with permissions
### ✓ Audit/event model — real event log
### ✓ Credential manifest — real manifest (needs validation upgrade)
### ✓ BYOK concept — real abstraction (needs real adapters)
### ✓ Dashboard UI — real 8-tab interface (keep)
### ✓ Authentication — real NextAuth + bcrypt + waitlist
### ✓ Multi-tenancy — real userId scoping on all queries

---

## P0 Implementation Plan

| # | System | File | Status |
|---|--------|------|--------|
| 1 | Real Git/worktree engine | `src/lib/git-engine.ts` | TODO |
| 2 | Real execution worker | `src/lib/worker.ts` | TODO |
| 3 | Real test runner | `src/lib/test-runner.ts` | TODO |
| 4 | Remove TemplateAdapter from prod | `src/lib/llm.ts` | TODO |
| 5 | Real LLM gateway | `src/lib/llm-gateway.ts` | TODO |
| 6 | Real GitHub adapter | `src/lib/github.ts` | TODO |
| 7 | Real secret store | `src/lib/secret-store.ts` | TODO |

## P1 Implementation Plan

| # | System | File | Status |
|---|--------|------|--------|
| 8 | Deterministic Guardian | `src/lib/guardian-deterministic.ts` | TODO |
| 9 | Executable architecture contract | `src/lib/contract.ts` | TODO |
| 10 | Evidence ledger | Prisma model update | TODO |
| 11 | Executable readiness policy | `src/lib/readiness-executor.ts` | TODO |
| 12 | Independent reviewer with real diff | orchestrator update | TODO |

## Environment Constraints

- **Docker**: NOT available. Execution worker uses subprocess isolation (real process, real filesystem, real timeout). Not container-level isolation. Documented as a limitation.
- **Git**: Available (v2.47.3). Real clone/worktree/commit/push.
- **GitHub PAT**: Available. Real GitHub API calls.
- **Neon PostgreSQL**: Available. Shared between sandbox and Vercel.
- **LLM**: z-ai-web-dev-sdk available in sandbox. BYOK providers need real API keys.
