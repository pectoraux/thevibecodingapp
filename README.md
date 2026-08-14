# Forge — Autonomous Software Factory

A multi-agent AI software factory that turns a product spec into a real, deployable, working software product. Multiple LLMs with different responsibilities collaborate through a controlled workflow, with GitHub as the source of truth, a frozen architecture as the governing contract, automated verification at every stage, and a production-readiness gate that proves the generated product is actually implemented.

> **Status: Development Prototype.** This platform is not yet production-ready. The execution plane uses process-level isolation (not container/microVM). See [AUDIT.md](./AUDIT.md) for the current capability assessment.

## Architecture

```
CONTROL PLANE (Next.js)
    ├── users, projects, architecture, tasks, agents
    ├── model routing, credential metadata
    ├── evidence ledger, audit log, state machine
    └── durable job queue
            │
            │ HMAC-signed job tokens
            ▼
EXECUTION PLANE (Worker)
    ├── authenticated HTTP API (port 3001)
    ├── server-controlled sandboxes
    ├── path containment + env allowlist
    ├── real git/worktree operations
    ├── real test execution
    └── real GitHub API calls
```

## Security Properties (Phase 4)

- **Authenticated worker**: Every `/execute` request requires an HMAC-SHA256 signed job token. Unauthenticated requests get 401.
- **No CORS**: The worker is a backend service. Browser clients cannot call it.
- **Server-controlled workspaces**: The client cannot specify filesystem paths. The worker generates sandbox IDs and paths internally.
- **Path containment**: Path traversal (`../`), absolute paths, null bytes, and symlink escapes are rejected.
- **Environment allowlist**: Child processes receive ONLY an explicit allowlist. Platform secrets (`DATABASE_URL`, `FORGE_MASTER_KEY`, `NEXTAUTH_SECRET`, `GITHUB_PAT`) are forbidden.
- **Command policy**: Dangerous commands (shutdown, mount, dd, fork bombs) are blocked.
- **Cross-tenant isolation**: A sandbox created by tenant A cannot be accessed by tenant B.

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript 5
- **Database**: PostgreSQL (Neon) via Prisma ORM
- **Auth**: NextAuth.js v4 (Credentials provider, JWT sessions)
- **Styling**: Tailwind CSS 4 with shadcn/ui
- **Execution**: Isolated worker process (HMAC-authenticated)
- **LLM**: Real provider adapters (OpenAI, Anthropic, Google, xAI, zAI) — no template fallback in production

## Quick Start

```bash
# Install dependencies
bun install

# Generate Prisma client
bun run db:generate

# Push schema to database
bun run db:push

# Seed admin + demo users
bun run seed

# Start the execution worker (separate terminal)
cd mini-services/execution-worker
FORGE_WORKER_SECRET="your-shared-secret" bash start-worker.sh

# Start the control plane
bun run dev
```

## Environment Variables

```env
# Database — Neon PostgreSQL
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

# NextAuth
NEXTAUTH_SECRET="..."
NEXTAUTH_URL="http://localhost:3000"

# Secret store (AES-256-GCM master key)
FORGE_MASTER_KEY="..."

# Execution worker
FORGE_EXECUTION_MODE="local"  # or "sandbox" for production
FORGE_EXECUTION_WORKER_URL="http://localhost:3001"
FORGE_WORKER_SECRET="..."  # shared HMAC secret between control plane and worker
```

## Execution Modes

| Mode | Description | Production-safe? |
|------|-------------|-----------------|
| `local` | Subprocess execution inside the Next.js process | ❌ Dev only |
| `sandbox` | Isolated worker process with HMAC auth | ✅ (with container/microVM substrate) |

The UI displays the current mode. Production should refuse to start in `local` mode.

## Documentation

- [AUDIT.md](./AUDIT.md) — Simulation vs reality audit
- [worklog.md](./worklog.md) — Implementation history

## License

Private
