# Forge — Autonomous Software Factory

A multi-agent AI software factory that turns a product spec into a real, deployable, working software product. Multiple LLMs with different responsibilities collaborate through a controlled workflow, with GitHub as the source of truth, a frozen architecture as the governing contract, automated verification at every stage, and a production-readiness gate that proves the generated product is actually implemented.

## Features

- **Multi-Agent Orchestration** — Architect, Architecture Guardian, Code Reviewer, Frontend/Backend/Database/Infrastructure/Integration/QA agents
- **Architecture Contract** — Machine-readable, freezable, with Guardian-enforced invariants
- **Autonomous Build Loop** — Implementation → Tests → Commit → Guardian → Review → Repair/Complete
- **Production Readiness Gate** — 14 evidence-based checks across 12 categories
- **Fake Implementation Detector** — Catches TODOs, mocks, stubs, placeholders in production paths
- **BYOK** — Bring your own LLM API keys (OpenAI, Anthropic, Google, xAI, or use the built-in sandbox LLM)
- **Virtual GitHub** — DB-backed repository simulation (branches, commits, PRs)
- **Authentication** — Email/password with waitlist signup flow and admin approval
- **Multi-tenant** — Each user sees only their own projects

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **Language**: TypeScript 5
- **Database**: PostgreSQL (Neon) via Prisma ORM
- **Auth**: NextAuth.js v4 (Credentials provider, JWT sessions)
- **Styling**: Tailwind CSS 4 with shadcn/ui
- **State**: Zustand (client) + TanStack Query (server)
- **LLM**: z-ai-web-dev-sdk (sandbox) with template-based fallback for production

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

# Start dev server
bun run dev
```

## Environment Variables

```env
DATABASE_URL="postgresql://..."     # Neon pooled connection string
DIRECT_URL="postgresql://..."        # Neon direct connection string (for migrations)
NEXTAUTH_SECRET="..."                # Random secret for JWT signing
NEXTAUTH_URL="http://localhost:3000" # App URL
FORGE_SECRET="..."                   # Secret for credential obfuscation
```

## Demo Accounts

- **Admin**: `ekontetevi@gmail.com` / `Payswap123456`
- **Demo Admin**: `demo.admin@forge.local` / `demo-admin-2024`
- **Demo User**: `demo.user@forge.local` / `demo-user-2024`

## How It Works

1. **Create a project** with a product spec, requirements, and desired stack
2. **Generate architecture** — the Architect agent designs the complete system
3. **Review and freeze** the architecture as an immutable contract
4. **Connect GitHub** and configure required credentials
5. **Start Build** — the autonomous loop runs:
   - Implementation agents produce real code
   - Tests run with evidence
   - Architecture Guardian checks for drift
   - Independent Code Reviewer requests changes if needed
   - Repair loop retries failed tasks (up to 3 attempts)
6. **Production Readiness Gate** — 14 checks must pass before `PRODUCTION_READY`

## License

Private
