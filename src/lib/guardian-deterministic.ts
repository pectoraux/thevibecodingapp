// Forge — Deterministic Architecture Guardian (Layer 1).
//
// This module performs MECHANICAL, DETERMINISTIC checks against the frozen
// Architecture Contract. It does NOT call any LLM. It runs before the
// semantic LLM Guardian (Layer 2) and produces evidence the LLM Guardian
// (and the orchestrator) can use to override or corroborate.
//
// Design principles:
//   - False positives are acceptable (the LLM Guardian can override).
//   - False negatives are NOT acceptable (every real violation must be caught).
//   - Test files are exempt from dependency / forbidden-tech checks
//     (mocks in tests are valid; mocks in production paths are violations).
//   - All evidence is structured: each finding lists the check, the
//     invariant, the specific evidence, the affected files, severity, and
//     a concrete remediation the agent (or human) can act on.
//
// Checks implemented (matching AUDIT.md P1-8):
//   1. Dependency additions / removals / downgrades
//      (package.json, requirements.txt, go.mod, Cargo.toml, pyproject.toml)
//   2. Forbidden technologies (imports not in the declared tech stack)
//   3. API contract changes (declared endpoints removed; method mismatch)
//   4. Database schema violations (declared models missing; extra models)
//   5. Directory / service boundary violations (frontend vs backend vs db)
//   6. Environment variable changes (.env.example removed / undeclared)
//   7. Infrastructure changes (Dockerfile / compose / CI vs deploymentModel)
//   8. Architecture version / hash mismatch (stale frozen contract)
//   9. Required component presence (every declared component has a file/dir)

import type { GuardianVerdict } from "@/lib/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GuardianFinding {
  check: string; // name of the check that found this
  invariant: string; // which invariant was violated
  evidence: string; // specific, human-readable evidence
  files: string[]; // affected files
  severity: "low" | "medium" | "high";
  remediation: string;
}

export interface GuardianCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface DeterministicGuardianResult {
  verdict: GuardianVerdict;
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  checks: GuardianCheck[];
  summary: string;
  // The architecture version/hash the implementation was checked against.
  architectureVersion: string;
  architectureHash: string;
  // ISO timestamp — when this check ran (for evidence ledger).
  checkedAt: string;
  // Total file count analyzed (for evidence / debugging).
  filesAnalyzed: number;
}

export interface GuardianChangedFile {
  path: string;
  content: string;
  previousContent?: string;
  action?: "added" | "modified" | "deleted";
}

export interface GuardianArchitecture {
  version: string;
  hash: string;
  components: ArchitectureComponent[];
  dataModels: DataModel[];
  apiContracts: ApiContract[];
  invariants: string[];
  constraints: string[];
  deploymentModel: DeploymentModel;
  requiredCredentials?: RequiredCredential[];
}

export interface ArchitectureComponent {
  name: string;
  type: string; // "frontend" | "backend" | "database" | "infra" | "integration" | "qa" | custom
  description?: string;
  tech?: string[];
  responsibilities?: string[];
  paths?: string[]; // optional declared file/dir paths for this component
}

export interface DataModel {
  name: string;
  fields?: { name: string; type: string; required?: boolean }[];
  description?: string;
}

export interface ApiContract {
  method: string; // "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  path: string; // e.g. "/api/users/:id" or "/api/users/[id]"
  description?: string;
  auth?: string;
  request?: string;
  response?: string;
}

export interface DeploymentModel {
  artifact?: string; // e.g. "docker-image", "vercel", "binary"
  platform?: string; // e.g. "aws-ecs", "vercel", "gcp-cloud-run"
  healthCheck?: string;
  rollbackStrategy?: string;
  containerized?: boolean;
}

export interface RequiredCredential {
  name: string;
  purpose?: string;
  required?: boolean;
}

export interface GuardianInput {
  architecture: GuardianArchitecture;
  changedFiles: GuardianChangedFile[];
  diff: string;
  /** Architecture version the implementation claims it was built under (optional). */
  implementationArchitectureVersion?: string;
  implementationArchitectureHash?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PACKAGE_FILES = [
  "package.json",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

const SCHEMA_FILES = [
  "prisma/schema.prisma",
  "schema.prisma",
  "db/schema.sql",
  "migrations/schema.sql",
];

const INFRA_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/build.yml",
  "terraform/main.tf",
  "infra/main.tf",
];

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template"];

const TEST_PATH_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /\/__tests__\//,
  /\/tests?\//,
  /\/__mocks__\//,
  /\.stories\.[tj]sx?$/,
  /test_[a-z0-9_]+\.[tj]sx?$/,
  /_test\.go$/,
];

function isTestFile(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}

function isPackageFile(path: string): boolean {
  const base = path.split("/").pop() || path;
  return PACKAGE_FILES.includes(base) || path.endsWith("package.json");
}

function isSchemaFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    SCHEMA_FILES.some((f) => lower.endsWith(f)) ||
    lower.endsWith("schema.prisma") ||
    lower.endsWith("/models.py") ||
    lower.endsWith("/models.ts") ||
    lower.endsWith("schema.sql") ||
    lower.endsWith("/entities/*.ts") ||
    /\.prisma$/.test(lower) ||
    /\/migrations\/.*\.sql$/.test(lower)
  );
}

function isInfraFile(path: string): boolean {
  return (
    INFRA_FILES.some((f) => path === f || path.endsWith("/" + f)) ||
    /^Dockerfile(\..+)?$/.test(path.split("/").pop() || "") ||
    /^docker-compose/.test(path.split("/").pop() || "") ||
    /^compose\.(yml|yaml)$/.test(path.split("/").pop() || "") ||
    /^\.github\/workflows\//.test(path)
  );
}

function isEnvExampleFile(path: string): boolean {
  return ENV_EXAMPLE_FILES.includes(path);
}

function isRouteFile(path: string): boolean {
  return (
    /\/api\/.*\/route\.[tj]sx?$/.test(path) ||
    /\/api\/.*\/handler\.[tj]sx?$/.test(path) ||
    /\/pages\/api\/.*\.[tj]sx?$/.test(path) ||
    /\/src\/routes\/.*\.[tj]sx?$/.test(path) ||
    /\/app\/http\/controllers\/.*\.[tj]sx?$/.test(path)
  );
}

/** Normalize an API path so `/api/users/:id` and `/api/users/[id]` compare equal. */
function normalizeApiPath(p: string): string {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  // Strip trailing slash (except root).
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  // Normalize dynamic segments to :name.
  s = s.replace(/\[([^\]]+)\]/g, ":$1");
  s = s.replace(/\{([^}]+)\}/g, ":$1");
  // Collapse :id vs :userId — for comparison we just care that SOMETHING is there.
  s = s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param");
  return s.toLowerCase();
}

function normalizeHttpMethod(m: string): string {
  return (m || "").trim().toUpperCase();
}

/** Try JSON.parse; on failure return null. Never throws. */
function tryJson<T = any>(s: string | undefined | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ---------------------------------------------------------------------------
// Dependency parsing — returns map of name → version (string)
// ---------------------------------------------------------------------------

interface ParsedDeps {
  source: string;
  deps: Record<string, string>;
}

function parsePackageJson(content: string): Record<string, string> {
  const j = tryJson<any>(content);
  if (!j || typeof j !== "object") return {};
  const out: Record<string, string> = {};
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (j[section] && typeof j[section] === "object") {
      for (const [k, v] of Object.entries(j[section])) {
        if (typeof v === "string") out[k] = v;
      }
    }
  }
  return out;
}

function parseRequirementsTxt(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Strip environment markers (e.g., ; python_version<"3.10").
    const semi = line.indexOf(";");
    const core = (semi >= 0 ? line.slice(0, semi) : line).trim();
    // Match: name [extras] OP version
    const m = core.match(/^([A-Za-z0-9_.-]+)(\[[^\]]+\])?\s*(==|~=|>=|<=|>|<|=)?\s*([A-Za-z0-9_.*+!-]*)/);
    if (m) {
      const name = m[1].toLowerCase();
      const op = m[3] || "";
      const ver = m[4] || "";
      out[name] = (op + ver).trim() || "any";
    }
  }
  return out;
}

function parseGoMod(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inRequireBlock = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock) {
      const m = line.match(/^([A-Za-z0-9_.\-\/]+)\s+(v[0-9.]+)/);
      if (m) out[m[1].toLowerCase()] = m[2];
      continue;
    }
    // Single-line require.
    const m = line.match(/^require\s+([A-Za-z0-9_.\-\/]+)\s+(v[0-9.]+)/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function parseCargoToml(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Naive TOML section + key parsing.
  let section = "";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (
      section === "dependencies" ||
      section === "dev-dependencies" ||
      section === "build-dependencies"
    ) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const name = m[1].toLowerCase();
      const val = m[2].trim();
      // `serde = { version = "1.0", features = [...] }` → "1.0"
      const vm = val.match(/version\s*=\s*"([^"]+)"/);
      out[name] = vm ? vm[1] : val.replace(/"/g, "");
    }
  }
  return out;
}

function parsePyprojectToml(content: string): Record<string, string> {
  // Reuse Cargo TOML parser shape (both are TOML).
  return parseCargoToml(content);
}

function parsePipfile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = "";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (section === "packages" || section === "dev-packages") {
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (m) out[m[1].toLowerCase()] = m[2].replace(/"/g, "");
    }
  }
  return out;
}

function parseDepsForFile(path: string, content: string): ParsedDeps | null {
  const base = basename(path);
  if (base === "package.json") {
    return { source: "npm", deps: parsePackageJson(content) };
  }
  if (base === "requirements.txt" || base === "requirements-dev.txt") {
    return { source: "pypi", deps: parseRequirementsTxt(content) };
  }
  if (base === "Pipfile") {
    return { source: "pypi", deps: parsePipfile(content) };
  }
  if (base === "pyproject.toml") {
    return { source: "pypi", deps: parsePyprojectToml(content) };
  }
  if (base === "go.mod") {
    return { source: "go", deps: parseGoMod(content) };
  }
  if (base === "Cargo.toml") {
    return { source: "cargo", deps: parseCargoToml(content) };
  }
  return null;
}

/** Loose semantic version compare: returns -1/0/1 for a vs b, or 0 if either is non-semver. */
function compareVersions(a: string, b: string): number {
  const na = a.replace(/^[^0-9]*/, "").split(/[.+-]/).filter(Boolean);
  const nb = b.replace(/^[^0-9]*/, "").split(/[.+-]/).filter(Boolean);
  if (!na.length || !nb.length) return 0;
  const max = Math.max(na.length, nb.length);
  for (let i = 0; i < max; i++) {
    const ai = parseInt(na[i] || "0", 10);
    const bi = parseInt(nb[i] || "0", 10);
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Forbidden-tech map: maps a declared tech string → allowed import substrings.
//
// When the architecture declares `tech: ["postgresql", "prisma"]`, the
// corresponding import patterns become ALLOWED. If code imports a library
// from a DIFFERENT ecosystem (e.g. `firebase`, `mongoose`, `mysql2` when
// only postgres is declared), that's a violation.
// ---------------------------------------------------------------------------

interface TechMapping {
  /** Substrings / package names that signal this tech is in use. */
  markers: string[];
  /** Alternative names that count as the same declared tech. */
  aliases?: string[];
}

const TECH_MAP: Record<string, TechMapping> = {
  // Databases / ORMs
  postgresql: { markers: ["pg", "postgres", "pg-promise", "knex"], aliases: ["postgres", "postgres-js"] },
  postgres: { markers: ["pg", "postgres", "pg-promise", "knex"], aliases: ["postgresql"] },
  mysql: { markers: ["mysql", "mysql2", "knex"] },
  sqlite: { markers: ["sqlite", "better-sqlite3", "sql.js"] },
  mongodb: { markers: ["mongodb", "mongoose"] },
  prisma: { markers: ["@prisma/client", "prisma"] },
  drizzle: { markers: ["drizzle-orm"] },
  typeorm: { markers: ["typeorm"] },
  sequelize: { markers: ["sequelize"] },
  sqlalchemy: { markers: ["sqlalchemy", "flask_sqlalchemy"] },
  firebase: { markers: ["firebase", "firebase-admin", "@firebase"] },
  supabase: { markers: ["@supabase/supabase-js", "supabase"] },
  dynamodb: { markers: ["@aws-sdk/client-dynamodb", "aws-sdk/clients/dynamodb"] },
  redis: { markers: ["ioredis", "redis", "node-redis"] },
  // Frontend frameworks
  react: { markers: ["react", "react-dom", "next"] },
  "next.js": { markers: ["next", "react"], aliases: ["next", "nextjs"] },
  nextjs: { markers: ["next"], aliases: ["next.js"] },
  vue: { markers: ["vue", "nuxt"] },
  svelte: { markers: ["svelte", "sveltekit"] },
  angular: { markers: ["@angular"] },
  // Backend frameworks
  "express": { markers: ["express"] },
  "fastify": { markers: ["fastify"] },
  "hono": { markers: ["hono"] },
  "nestjs": { markers: ["@nestjs"] },
  "django": { markers: ["django"] },
  "flask": { markers: ["flask"] },
  "fastapi": { markers: ["fastapi"] },
  "rails": { markers: ["rails"] },
  "gin": { markers: ["github.com/gin-gonic/gin"] },
  "echo": { markers: ["github.com/labstack/echo"] },
  // Styling
  tailwind: { markers: ["tailwindcss"], aliases: ["tailwindcss"] },
  "shadcn/ui": { markers: ["@radix-ui", "@/components/ui"] },
  // Auth
  nextauth: { markers: ["next-auth"], aliases: ["next-auth"] },
  clerk: { markers: ["@clerk"] },
  auth0: { markers: ["auth0"] },
  // Languages
  typescript: { markers: [] },
  javascript: { markers: [] },
  python: { markers: [] },
  go: { markers: [] },
  rust: { markers: [] },
};

/**
 * Build the set of allowed tech markers from the architecture's declared tech.
 * Anything NOT declared but imported (and recognized as a tech marker) is a
 * violation candidate.
 */
function buildAllowedTechSet(declared: string[]): {
  declared: Set<string>; // normalized declared names
  allowedMarkers: Set<string>; // import substrings allowed
} {
  const declaredSet = new Set<string>();
  const allowed = new Set<string>();
  for (const t of declared) {
    const key = t.toLowerCase().trim();
    declaredSet.add(key);
    const m = TECH_MAP[key];
    if (m) {
      for (const mk of m.markers) allowed.add(mk.toLowerCase());
      if (m.aliases) for (const a of m.aliases) {
        declaredSet.add(a.toLowerCase());
        const am = TECH_MAP[a.toLowerCase()];
        if (am) for (const mk2 of am.markers) allowed.add(mk2.toLowerCase());
      }
    }
  }
  return { declared: declaredSet, allowedMarkers: allowed };
}

/** Reverse-lookup: given an import, find which tech ecosystem it belongs to. */
function detectTechFromImport(imp: string): string | null {
  const k = imp.toLowerCase();
  for (const [tech, mapping] of Object.entries(TECH_MAP)) {
    if (mapping.markers.some((m) => k === m || k.startsWith(m + "/") || k.startsWith(m + "-"))) {
      return tech;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import extraction (very loose; works across TS/JS/Python/Go/Rust)
// ---------------------------------------------------------------------------

function extractImports(path: string, content: string): string[] {
  const out: string[] = [];
  if (/\.[tj]sx?$/.test(path)) {
    // import X from "mod" / import "mod" / require("mod")
    const re = /(?:import\s+(?:[^"'`]+\s+from\s+)?|require\s*\(\s*)["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(m[1]);
    return out;
  }
  if (/\.py$/.test(path)) {
    const re1 = /(?:^|\n)\s*(?:import|from)\s+([A-Za-z0-9_.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re1.exec(content)) !== null) out.push(m[1]);
    return out;
  }
  if (/\.go$/.test(path)) {
    const re = /(?:^|\n)\s*(?:import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"|import\s*\(\s*([\s\S]*?)\s*\))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) {
        out.push(m[1]);
      } else if (m[2]) {
        for (const line of m[2].split("\n")) {
          const lm = line.trim().match(/^"([^"]+)"$/);
          if (lm) out.push(lm[1]);
        }
      }
    }
    return out;
  }
  if (/\.rs$/.test(path)) {
    const re = /use\s+([A-Za-z0-9_:]+)(?:::\{[^}]+\})?;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(m[1].replace(/::/g, "/"));
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema parsing (Prisma + Django/SQLAlchemy + SQL DDL)
// ---------------------------------------------------------------------------

function extractPrismaModels(content: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  // enums too — record as `enum:Name`.
  const re2 = /(?:^|\n)\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  while ((m = re2.exec(content)) !== null) out.push("enum:" + m[1]);
  return out;
}

function extractPythonModels(content: string): string[] {
  const out: string[] = [];
  // Django: `class X(models.Model):`
  const re1 = /(?:^|\n)\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:[^)]*\b)?models\.Model\b/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(content)) !== null) out.push(m[1]);
  // SQLAlchemy: `class X(Base):`
  const re2 = /(?:^|\n)\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*Base\s*\)/g;
  while ((m = re2.exec(content)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function extractSqlTables(content: string): string[] {
  const out: string[] = [];
  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

function extractSchemaModels(path: string, content: string): string[] {
  if (/\.prisma$/.test(path)) return extractPrismaModels(content);
  if (/\.py$/.test(path)) return extractPythonModels(content);
  if (/\.sql$/.test(path)) return extractSqlTables(content);
  // TypeORM / class-based entities in TS:
  if (/\.[tj]sx?$/.test(path)) {
    const out: string[] = [];
    const re = /(?:^|\n)\s*@Entity\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(m[1]);
    const re2 = /(?:^|\n)\s*export\s+(?:default\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = re2.exec(content)) !== null) out.push(m[1]);
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// API route extraction
// ---------------------------------------------------------------------------

interface ExtractedRoute {
  path: string; // normalized, e.g. "/api/users/:param"
  method: string; // "GET" | "POST" | ...
  file: string;
}

function extractRoutes(path: string, content: string): ExtractedRoute[] {
  const out: ExtractedRoute[] = [];
  // Next.js App Router: app/api/users/[id]/route.ts → /api/users/:id, with export async function GET/POST/...
  const appMatch = path.match(/(?:app|src\/app|app\/api)\/api(.*)\/route\.[tj]sx?$/);
  if (appMatch) {
    const segs = appMatch[1] || "";
    const httpPath = "/api" + segs;
    const normalized = normalizeApiPath(httpPath);
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
    for (const m of methods) {
      const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`);
      if (re.test(content)) out.push({ path: normalized, method: m, file: path });
    }
    if (out.length === 0) {
      // Route file with no HTTP method exports → still register as a generic endpoint.
      out.push({ path: normalized, method: "ANY", file: path });
    }
    return out;
  }
  // Next.js Pages Router: pages/api/users/[id].ts → /api/users/:id
  const pagesMatch = path.match(/pages\/api(.*)\.[tj]sx?$/);
  if (pagesMatch) {
    const segs = pagesMatch[1].replace(/\.[tj]sx?$/, "");
    const httpPath = "/api" + segs;
    const normalized = normalizeApiPath(httpPath);
    // default export handler = supports any method the handler dispatches.
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
    for (const m of methods) {
      const re = new RegExp(`case\\s+['"]${m}['"]`);
      if (re.test(content)) out.push({ path: normalized, method: m, file: path });
    }
    if (out.length === 0) out.push({ path: normalized, method: "ANY", file: path });
    return out;
  }
  // Express: app.get("/api/...", ...) etc.
  const exRe = /app\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = exRe.exec(content)) !== null) {
    out.push({ path: normalizeApiPath(m[2]), method: normalizeHttpMethod(m[1]), file: path });
  }
  // Fastify: fastify.get("/api/...", ...)
  const fastRe = /fastify\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((m = fastRe.exec(content)) !== null) {
    out.push({ path: normalizeApiPath(m[2]), method: normalizeHttpMethod(m[1]), file: path });
  }
  // Django: path("api/...", views.x) or re_path
  const djRe = /(?:path|re_path)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = djRe.exec(content)) !== null) {
    out.push({ path: normalizeApiPath(m[1]), method: "ANY", file: path });
  }
  return out;
}

// ---------------------------------------------------------------------------
// .env.example parsing
// ---------------------------------------------------------------------------

function parseEnvExample(content: string): { names: string[]; declaredRequired: string[] } {
  const names = new Set<string>();
  const declaredRequired: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      // Some examples annotate required vars as comments like `# REQUIRED: KEY=...`.
      const m = line.match(/#.*REQUIRED:?\s*([A-Z_][A-Z0-9_]*)/i);
      if (m) declaredRequired.push(m[1]);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    if (/^[A-Z_][A-Z0-9_]*$/i.test(name)) names.add(name);
  }
  return { names: Array.from(names), declaredRequired };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

interface CheckContext {
  arch: GuardianArchitecture;
  changedFiles: GuardianChangedFile[];
  diff: string;
  implVersion?: string;
  implHash?: string;
}

function makeFinding(
  check: string,
  invariant: string,
  evidence: string,
  files: string[],
  severity: "low" | "medium" | "high",
  remediation: string,
): GuardianFinding {
  return { check, invariant, evidence, files, severity, remediation };
}

// Check 1: Dependency additions / removals / downgrades
function checkDependencies(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  // Build declared tech set for "new dep not in declared stack" check.
  const declaredTech = new Set<string>();
  for (const c of arch.components) {
    for (const t of c.tech || []) declaredTech.add(t.toLowerCase().trim());
  }
  const { allowedMarkers } = buildAllowedTechSet(Array.from(declaredTech));

  // Find package file changes.
  const pkgFiles = changedFiles.filter((f) => isPackageFile(f.path));
  if (pkgFiles.length === 0) {
    return {
      violations,
      warnings,
      check: {
        name: "dependencies",
        passed: true,
        details: "No package/manifest file changes detected in this diff.",
      },
    };
  }

  for (const f of pkgFiles) {
    const before = f.previousContent ? parseDepsForFile(f.path, f.previousContent) : null;
    const after = f.content ? parseDepsForFile(f.path, f.content) : null;
    if (!after) continue;
    const beforeDeps = before?.deps || {};

    const added = Object.keys(after.deps).filter((k) => !(k in beforeDeps));
    const removed = Object.keys(beforeDeps).filter((k) => !(k in after.deps));
    const downgraded: { name: string; from: string; to: string }[] = [];
    for (const k of Object.keys(after.deps)) {
      if (k in beforeDeps) {
        const cmp = compareVersions(after.deps[k], beforeDeps[k]);
        if (cmp < 0) downgraded.push({ name: k, from: beforeDeps[k], to: after.deps[k] });
      }
    }

    // Heuristic: is this a new "major" tech add (DB, ORM, framework) that's not declared?
    const forbiddenAdds: string[] = [];
    const benignAdds: string[] = [];
    for (const dep of added) {
      const detectedTech = detectTechFromImport(dep);
      if (detectedTech && !declaredTech.has(detectedTech) && !declaredTech.has(dep)) {
        // Check if the dep's tech ecosystem overlaps with declared tech's allowed markers.
        // E.g. declared `prisma` → markers include "@prisma/client" → installing @prisma/client is fine.
        const depLower = dep.toLowerCase();
        const isAllowed = Array.from(allowedMarkers).some(
          (mk) => depLower === mk || depLower.startsWith(mk + "/") || depLower.startsWith(mk + "-") || depLower.startsWith("@") && depLower.split("/")[0] === mk,
        );
        if (!isAllowed) {
          forbiddenAdds.push(`${dep}@${after.deps[dep]} (detected tech: ${detectedTech})`);
        } else {
          benignAdds.push(`${dep}@${after.deps[dep]}`);
        }
      } else {
        benignAdds.push(`${dep}@${after.deps[dep]}`);
      }
    }

    if (forbiddenAdds.length > 0) {
      violations.push(
        makeFinding(
          "dependencies",
          "tech-stack-frozen: dependencies must match the architecture's declared components[].tech",
          `package file ${f.path} adds dependencies whose ecosystem is NOT declared in the architecture: ${forbiddenAdds.join(", ")}. Declared tech: [${Array.from(declaredTech).join(", ") || "(none)"}].`,
          [f.path],
          "high",
          `Either remove these dependencies or update the architecture contract (via Architecture Change Request) to declare the new tech.`,
        ),
      );
    }

    if (removed.length > 0) {
      // Removal is a warning unless the removed package was a declared tech marker.
      const criticalRemovals = removed.filter((r) => {
        const t = detectTechFromImport(r);
        return t && declaredTech.has(t);
      });
      if (criticalRemovals.length > 0) {
        violations.push(
          makeFinding(
            "dependencies",
            "tech-stack-frozen: declared technologies must not be removed without a change request",
            `package file ${f.path} removes dependencies that are part of the declared tech stack: ${criticalRemovals.join(", ")}.`,
            [f.path],
            "high",
            `Restore these dependencies or update the architecture contract to remove the tech declaration.`,
          ),
        );
      } else {
        warnings.push(
          makeFinding(
            "dependencies",
            "dependency-removal: removed dependencies may break dependent code",
            `package file ${f.path} removes: ${removed.join(", ")}.`,
            [f.path],
            "low",
            `Verify no other code depends on these packages.`,
          ),
        );
      }
    }

    if (downgraded.length > 0) {
      warnings.push(
        makeFinding(
          "dependencies",
          "dependency-downgrade: version downgrades may introduce regressions",
          `package file ${f.path} downgraded: ${downgraded.map((d) => `${d.name} ${d.from} → ${d.to}`).join(", ")}.`,
          [f.path],
          "medium",
          `Confirm the downgrade is intentional and doesn't break compatibility.`,
        ),
      );
    }

    if (benignAdds.length > 0 && forbiddenAdds.length === 0) {
      // Informational warning so the LLM Guardian sees it.
      warnings.push(
        makeFinding(
          "dependencies",
          "dependency-addition: new dependencies were added (within declared stack)",
          `package file ${f.path} added: ${benignAdds.join(", ")}.`,
          [f.path],
          "low",
          `No action required if these are within the declared tech stack.`,
        ),
      );
    }
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "dependencies",
      passed: !hasViolation,
      details: hasViolation
        ? `${violations.length} dependency violation(s) found across ${pkgFiles.length} package file(s).`
        : `${pkgFiles.length} package file(s) checked; no forbidden-tech dependency changes.`,
    },
  };
}

// Check 2: Forbidden technologies (imports not in declared stack)
function checkForbiddenTech(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  const declaredTech = new Set<string>();
  for (const c of arch.components) for (const t of c.tech || []) declaredTech.add(t.toLowerCase().trim());
  const { allowedMarkers } = buildAllowedTechSet(Array.from(declaredTech));

  // Map file → set of "suspect imports" (imports whose tech ecosystem is NOT in declaredTech).
  const suspects = new Map<string, Set<string>>();

  for (const f of changedFiles) {
    if (isTestFile(f.path)) continue; // test files exempt
    if (isPackageFile(f.path)) continue; // handled by check 1
    if (!f.content) continue;
    const imps = extractImports(f.path, f.content);
    for (const imp of imps) {
      const detected = detectTechFromImport(imp);
      if (!detected) continue; // unrecognized — not our concern
      if (declaredTech.has(detected)) continue; // declared — fine
      // Is this import's marker part of declared tech's allowed set (e.g. @prisma/client when prisma declared)?
      const impLower = imp.toLowerCase();
      const isAllowed = Array.from(allowedMarkers).some(
        (mk) => impLower === mk || impLower.startsWith(mk + "/") || impLower.startsWith(mk + "-"),
      );
      if (isAllowed) continue;
      // Skip relative imports and node built-ins.
      if (imp.startsWith(".") || imp.startsWith("/")) continue;
      if (["node:", "react", "react-dom"].includes(imp.split("/")[0])) continue;
      if (!suspects.has(f.path)) suspects.set(f.path, new Set());
      suspects.get(f.path)!.add(`${imp} (tech: ${detected})`);
    }
  }

  if (suspects.size > 0) {
    for (const [path, set] of Array.from(suspects.entries())) {
      violations.push(
        makeFinding(
          "forbidden-tech",
          "tech-stack-frozen: imports must come from declared components[].tech",
          `File ${path} imports libraries whose tech ecosystem is not declared in the architecture: ${Array.from(set).join(", ")}. Declared tech: [${Array.from(declaredTech).join(", ") || "(none)"}].`,
          [path],
          "high",
          `Remove the import or update the architecture contract to declare the new tech via an Architecture Change Request.`,
        ),
      );
    }
    return {
      violations,
      warnings,
      check: {
        name: "forbidden-tech",
        passed: false,
        details: `${suspects.size} file(s) contain imports from undeclared tech ecosystems.`,
      },
    };
  }

  return {
    violations,
    warnings,
    check: {
      name: "forbidden-tech",
      passed: true,
      details: `No imports from undeclared tech ecosystems detected across ${changedFiles.length} changed file(s).`,
    },
  };
}

// Check 3: API contract changes
function checkApiContracts(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  if (!arch.apiContracts || arch.apiContracts.length === 0) {
    return {
      violations,
      warnings,
      check: {
        name: "api-contracts",
        passed: true,
        details: "Architecture declares no API contracts; skipping endpoint checks.",
      },
    };
  }

  // Extract routes from all changed files (these are the candidate endpoints).
  const implementedRoutes: ExtractedRoute[] = [];
  for (const f of changedFiles) {
    if (isRouteFile(f.path) && f.content) {
      implementedRoutes.push(...extractRoutes(f.path, f.content));
    }
  }

  // Declared contract set keyed by normalized path.
  const declaredByPath = new Map<string, ApiContract[]>();
  for (const c of arch.apiContracts) {
    const key = normalizeApiPath(c.path);
    if (!declaredByPath.has(key)) declaredByPath.set(key, []);
    declaredByPath.get(key)!.push(c);
  }
  const declaredPaths = new Set(declaredByPath.keys());

  const implementedByPath = new Map<string, ExtractedRoute[]>();
  for (const r of implementedRoutes) {
    if (!implementedByPath.has(r.path)) implementedByPath.set(r.path, []);
    implementedByPath.get(r.path)!.push(r);
  }
  const implementedPaths = new Set(implementedByPath.keys());

  // Violation: declared endpoint missing.
  for (const [key, contracts] of Array.from(declaredByPath.entries())) {
    if (!implementedPaths.has(key)) {
      // Only flag as missing if route files exist in the change set (i.e. we expected routes).
      const anyRouteInDiff = changedFiles.some((f) => isRouteFile(f.path));
      if (anyRouteInDiff) {
        violations.push(
          makeFinding(
            "api-contracts",
            "api-contract-frozen: declared API endpoints must not be removed",
            `Declared API endpoint ${contracts[0].method} ${contracts[0].path} (normalized: ${key}) has no implementation in the changed route files.`,
            changedFiles.filter((f) => isRouteFile(f.path)).map((f) => f.path),
            "high",
            `Restore the route handler for ${contracts[0].method} ${contracts[0].path} or update the architecture contract via a Change Request.`,
          ),
        );
      }
    } else {
      // Endpoint exists — verify method matches.
      const impls = implementedByPath.get(key)!;
      for (const c of contracts) {
        const declaredMethod = normalizeHttpMethod(c.method);
        if (declaredMethod === "ANY") continue;
        const hasMethod = impls.some((r) => r.method === declaredMethod || r.method === "ANY");
        if (!hasMethod) {
          violations.push(
            makeFinding(
              "api-contracts",
              "api-contract-frozen: HTTP methods must match the declared contract",
              `Route ${c.path} (normalized: ${key}) is declared as ${declaredMethod} but the implementation exports methods: ${uniq(impls.map((r) => r.method)).join(", ")}.`,
              uniq(impls.map((r) => r.file)),
              "high",
              `Add an export for ${declaredMethod} on ${c.path} or update the contract via a Change Request.`,
            ),
          );
        }
      }
    }
  }

  // Warning: extra endpoint not in contract.
  for (const [key, impls] of Array.from(implementedByPath.entries())) {
    if (!declaredPaths.has(key)) {
      warnings.push(
        makeFinding(
          "api-contracts",
          "api-contract-drift: new endpoint not declared in the contract",
          `Implementation adds route ${impls[0].method} ${impls[0].path} (normalized: ${key}) which is not in the declared API contract.`,
          uniq(impls.map((r) => r.file)),
          "low",
          `If the endpoint is intentional, add it to the architecture contract via a Change Request.`,
        ),
      );
    }
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "api-contracts",
      passed: !hasViolation,
      details: hasViolation
        ? `${violations.length} API contract violation(s) across ${declaredPaths.size} declared endpoint(s).`
        : `${declaredPaths.size} declared endpoint(s) verified; ${implementedPaths.size} route(s) found in diff.`,
    },
  };
}

// Check 4: Database schema violations
function checkDbSchema(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  if (!arch.dataModels || arch.dataModels.length === 0) {
    return {
      violations,
      warnings,
      check: {
        name: "db-schema",
        passed: true,
        details: "Architecture declares no data models; skipping schema checks.",
      },
    };
  }

  const schemaFiles = changedFiles.filter((f) => isSchemaFile(f.path) && f.content);
  if (schemaFiles.length === 0) {
    // No schema files touched — but dataModels declared. Could be fine if this task is frontend-only.
    // We can't definitively say it's a violation; emit a warning if other backend files were touched.
    const anyBackendFile = changedFiles.some(
      (f) =>
        /\/(api|server|services?|src\/lib)\//.test(f.path) ||
        /\.(py|go|rs|rb|java)$/.test(f.path),
    );
    if (anyBackendFile) {
      warnings.push(
        makeFinding(
          "db-schema",
          "schema-presence: data models declared but no schema file in this change set",
          `Architecture declares ${arch.dataModels.length} data model(s) but the change set contains no schema files (prisma/schema.prisma, models.py, schema.sql, etc.).`,
          [],
          "low",
          `Verify the schema file already exists in the repo (this check only sees changed files).`,
        ),
      );
    }
    return {
      violations,
      warnings,
      check: {
        name: "db-schema",
        passed: true,
        details: "No schema files in the change set; cannot verify data models.",
      },
    };
  }

  // Extract all models defined in changed schema files.
  const definedModels = new Set<string>();
  const modelToFile = new Map<string, string>();
  for (const f of schemaFiles) {
    const models = extractSchemaModels(f.path, f.content || "");
    for (const m of models) {
      definedModels.add(m);
      modelToFile.set(m, f.path);
    }
  }

  // Declared model names (normalized to lowercase for comparison).
  const declaredNames = new Set<string>();
  for (const m of arch.dataModels) declaredNames.add(m.name);

  // Violation: declared model missing.
  const missing: string[] = [];
  for (const m of arch.dataModels) {
    if (!definedModels.has(m.name)) {
      // Loose check: case-insensitive.
      const found = Array.from(definedModels).find((d) => d.toLowerCase() === m.name.toLowerCase());
      if (!found) missing.push(m.name);
    }
  }
  if (missing.length > 0) {
    violations.push(
      makeFinding(
        "db-schema",
        "data-model-frozen: declared data models must be defined in schema files",
        `Architecture declares data model(s) [${missing.join(", ")}] but no matching schema model was found in changed schema files. Found: [${Array.from(definedModels).join(", ") || "(none)"}].`,
        schemaFiles.map((f) => f.path),
        "high",
        `Add the missing model(s) to the schema file(s) or update the architecture contract via a Change Request.`,
      ),
    );
  }

  // Warning: extra model not in contract.
  const declaredLower = new Set(Array.from(declaredNames).map((n) => n.toLowerCase()));
  const extras = Array.from(definedModels).filter((d) => {
    if (d.startsWith("enum:")) return false; // enums are implementation details
    return !declaredLower.has(d.toLowerCase());
  });
  if (extras.length > 0) {
    warnings.push(
      makeFinding(
        "db-schema",
        "data-model-drift: schema defines models not in the contract",
        `Schema files define model(s) [${extras.join(", ")}] not declared in the architecture contract.`,
        uniq(extras.map((e) => modelToFile.get(e) || "")),
        "low",
        `If intentional, add the new model(s) to the architecture contract via a Change Request.`,
      ),
    );
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "db-schema",
      passed: !hasViolation,
      details: hasViolation
        ? `${missing.length} declared model(s) missing; ${extras.length} extra model(s) found.`
        : `All ${declaredNames.size} declared model(s) present; ${extras.length} extra model(s) flagged as warnings.`,
    },
  };
}

// Check 5: Directory / service boundary violations
function checkBoundaries(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  // Map component type → expected directory prefix.
  const typeToPrefix: Record<string, string[]> = {
    frontend: ["src/components", "src/app", "src/pages", "components", "app", "pages", "public", "src/hooks", "src/lib/ui"],
    backend: ["src/app/api", "src/server", "server", "src/services", "src/lib", "api", "app/http", "src/routes"],
    database: ["prisma", "db", "migrations", "schema", "src/db", "src/models", "models"],
    infra: ["Dockerfile", "docker-compose", ".github", "terraform", "infra", "k8s", "helm", ".dockerignore"],
    integration: ["src/integrations", "src/lib/integrations", "integrations", "src/services/integrations"],
    qa: ["tests", "test", "e2e", "__tests__", "src/__tests__", "cypress", "playwright"],
  };

  // Build a list of (component name → allowed prefixes) from the architecture.
  const componentExpectations: { name: string; type: string; prefixes: string[] }[] = [];
  for (const c of arch.components) {
    const type = (c.type || "").toLowerCase();
    const prefixes = c.paths && c.paths.length > 0 ? c.paths : typeToPrefix[type] || [];
    componentExpectations.push({ name: c.name, type, prefixes });
  }

  // For each changed file, determine which component type it belongs to by path.
  // Then check: does the file's path match ANY component of that type's prefixes?
  for (const f of changedFiles) {
    if (isTestFile(f.path)) continue;
    const type = guessComponentTypeFromPath(f.path);
    if (!type) continue;
    const expected = typeToPrefix[type] || [];
    if (expected.length === 0) continue;
    const matchesExpected = expected.some((p) => f.path === p || f.path.startsWith(p + "/") || f.path.startsWith(p));
    if (!matchesExpected) {
      // Only flag if the architecture actually declares a component of this type.
      const archDeclares = arch.components.some((c) => (c.type || "").toLowerCase() === type);
      if (!archDeclares) continue;
      // Determine which declared component(s) of this type exist.
      const declaredComps = arch.components.filter((c) => (c.type || "").toLowerCase() === type);
      violations.push(
        makeFinding(
          "boundaries",
          "service-boundary-frozen: code must live in directories consistent with its component type",
          `File ${f.path} looks like ${type} code (based on path) but does not live under any of the expected ${type} directories: [${expected.join(", ")}]. Declared ${type} component(s): ${declaredComps.map((c) => c.name).join(", ")}.`,
          [f.path],
          "medium",
          `Move the file to one of the expected ${type} directories or update the architecture to declare this directory.`,
        ),
      );
    }
  }

  // Cross-check: backend code in frontend dirs and vice-versa.
  const backendPatterns = [/^src\/app\/api\//, /^src\/server\//, /^server\//, /^api\//, /^src\/services\//];
  const frontendPatterns = [/^src\/components\//, /^src\/app\/(?!api)/, /^components\//, /^app\/(?!api)/, /^pages\/(?!api)/];

  for (const f of changedFiles) {
    if (isTestFile(f.path) || !f.content) continue;
    const isBackendByPath = backendPatterns.some((re) => re.test(f.path));
    const isFrontendByPath = frontendPatterns.some((re) => re.test(f.path));
    if (isBackendByPath && isFrontendByPath) continue; // ambiguous
    if (isBackendByPath && /\.[tj]sx$/.test(f.path) && /export\s+default\s+function\s+\w+\s*\(\s*\)\s*\{[\s\S]*?return\s*</.test(f.content.slice(0, 1200))) {
      // A backend route file that's rendering JSX → may be a frontend page misplaced.
      warnings.push(
        makeFinding(
          "boundaries",
          "service-boundary: backend route file appears to render UI",
          `File ${f.path} is in a backend directory but appears to render JSX markup. Frontend UI should live in src/components or src/app/<page>.`,
          [f.path],
          "low",
          `Move JSX rendering to a frontend component and import it from the route handler if needed.`,
        ),
      );
    }
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "boundaries",
      passed: !hasViolation,
      details: hasViolation
        ? `${violations.length} boundary violation(s) found.`
        : `All changed files live in directories consistent with their component type.`,
    },
  };
}

function guessComponentTypeFromPath(path: string): string | null {
  if (/^(src\/)?app\/api\//.test(path) || /^(src\/)?server\//.test(path) || /^api\//.test(path) || /^(src\/)?services\//.test(path)) return "backend";
  if (/^(src\/)?components\//.test(path) || /^(src\/)?app\/(?!api)/.test(path) || /^(src\/)?pages\/(?!api)/.test(path) || /^app\/(?!api)/.test(path)) return "frontend";
  if (/^prisma\//.test(path) || /^db\//.test(path) || /^migrations\//.test(path) || /^src\/db\//.test(path) || /^src\/models\//.test(path) || /^models\//.test(path)) return "database";
  if (/^Dockerfile/.test(path) || /^docker-compose/.test(path) || /^\.github\//.test(path) || /^terraform\//.test(path) || /^infra\//.test(path)) return "infra";
  if (/^src\/integrations\//.test(path) || /^integrations\//.test(path)) return "integration";
  if (/^tests?\//.test(path) || /^__tests__\//.test(path) || /^e2e\//.test(path) || /^cypress\//.test(path)) return "qa";
  return null;
}

// Check 6: Environment variable changes
function checkEnvVars(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  const envFiles = changedFiles.filter((f) => isEnvExampleFile(f.path));
  if (envFiles.length === 0) {
    return {
      violations,
      warnings,
      check: {
        name: "env-vars",
        passed: true,
        details: "No .env.example file changes detected.",
      },
    };
  }

  // Required credentials → env vars (most projects use the credential name as env var).
  const requiredEnv = new Set<string>();
  for (const c of arch.requiredCredentials || []) {
    if (c.required !== false) requiredEnv.add(c.name);
  }

  for (const f of envFiles) {
    const before = f.previousContent ? parseEnvExample(f.previousContent) : { names: [], declaredRequired: [] };
    const after = f.content ? parseEnvExample(f.content) : { names: [], declaredRequired: [] };
    const beforeSet = new Set(before.names);
    const afterSet = new Set(after.names);
    const removed = before.names.filter((n) => !afterSet.has(n));
    const added = after.names.filter((n) => !beforeSet.has(n));

    // Violation: removal of a required env var.
    const criticalRemovals = removed.filter((n) => requiredEnv.has(n));
    if (criticalRemovals.length > 0) {
      violations.push(
        makeFinding(
          "env-vars",
          "env-frozen: required environment variables must not be removed from .env.example",
          `.env.example (${f.path}) removes required env var(s): [${criticalRemovals.join(", ")}].`,
          [f.path],
          "high",
          `Restore these env vars in .env.example or update the architecture's requiredCredentials.`,
        ),
      );
    }

    // Warning: addition of undeclared env vars.
    const undeclaredAdds = added.filter((n) => !requiredEnv.has(n));
    if (undeclaredAdds.length > 0) {
      warnings.push(
        makeFinding(
          "env-vars",
          "env-drift: new env vars not declared in requiredCredentials",
          `.env.example (${f.path}) adds env var(s) not in the architecture: [${undeclaredAdds.join(", ")}].`,
          [f.path],
          "low",
          `If intentional, add these to requiredCredentials via an Architecture Change Request.`,
        ),
      );
    }
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "env-vars",
      passed: !hasViolation,
      details: hasViolation
        ? `${violations.length} env var violation(s).`
        : `${envFiles.length} .env.example file(s) checked; no required env vars removed.`,
    },
  };
}

// Check 7: Infrastructure changes vs deployment model
function checkInfra(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  const infraFiles = changedFiles.filter((f) => isInfraFile(f.path));
  if (infraFiles.length === 0) {
    return {
      violations,
      warnings,
      check: {
        name: "infra",
        passed: true,
        details: "No Dockerfile / compose / CI changes detected.",
      },
    };
  }

  const dm = arch.deploymentModel || {};
  const declaredArtifact = (dm.artifact || "").toLowerCase();
  const declaredPlatform = (dm.platform || "").toLowerCase();
  const containerized = dm.containerized === true ||
    declaredArtifact.includes("docker") ||
    declaredPlatform.includes("ecs") ||
    declaredPlatform.includes("kubernetes") ||
    declaredPlatform.includes("k8s") ||
    declaredPlatform.includes("cloud-run") ||
    declaredPlatform.includes("fargate");

  for (const f of infraFiles) {
    const base = basename(f.path);
    const content = f.content || "";

    // If architecture declares Vercel (serverless) but a Dockerfile is added → drift.
    if (base.startsWith("Dockerfile") && declaredPlatform && !containerized) {
      if (declaredPlatform.includes("vercel") || declaredPlatform.includes("netlify") || declaredArtifact.includes("serverless")) {
        violations.push(
          makeFinding(
            "infra",
            "deployment-model-frozen: infrastructure must match declared deploymentModel",
            `Architecture declares deployment platform '${dm.platform}' (artifact '${dm.artifact}') but a Dockerfile was added (${f.path}).`,
            [f.path],
            "high",
            `Remove the Dockerfile or update the architecture's deploymentModel via a Change Request.`,
          ),
        );
      }
    }

    // If architecture declares containerized but no Dockerfile exists in change set → warning.
    if (containerized && base.startsWith("docker-compose")) {
      // Sanity: does the compose reference a service that builds a Dockerfile?
      if (!/build:\s*\./.test(content) && !/image:/.test(content)) {
        warnings.push(
          makeFinding(
            "infra",
            "deployment-model: docker-compose file has no build context or image",
            `docker-compose file ${f.path} declares no build context or image; the service may not be deployable.`,
            [f.path],
            "low",
            `Add a build: . or image: directive to each service.`,
          ),
        );
      }
    }

    // CI config drift: architecture says no CI? — likely fine, skip.
    // Health check: declared but missing from Dockerfile → warning.
    if (base.startsWith("Dockerfile") && dm.healthCheck) {
      if (!/HEALTHCHECK/.test(content)) {
        warnings.push(
          makeFinding(
            "infra",
            "deployment-model: healthCheck declared but not in Dockerfile",
            `Architecture declares a healthCheck (${dm.healthCheck}) but the Dockerfile (${f.path}) has no HEALTHCHECK instruction.`,
            [f.path],
            "low",
            `Add a HEALTHCHECK --interval=... CMD ${dm.healthCheck} instruction to the Dockerfile.`,
          ),
        );
      }
    }

    // If a Dockerfile was DELETED but architecture says containerized → violation.
    if (base.startsWith("Dockerfile") && f.action === "deleted" && containerized) {
      violations.push(
        makeFinding(
          "infra",
          "deployment-model-frozen: containerized deployment requires a Dockerfile",
          `Architecture declares a containerized deployment but ${f.path} was deleted.`,
          [f.path],
          "high",
          `Restore the Dockerfile or update the architecture's deploymentModel via a Change Request.`,
        ),
      );
    }
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "infra",
      passed: !hasViolation,
      details: hasViolation
        ? `${violations.length} infrastructure violation(s).`
        : `${infraFiles.length} infra file(s) checked; consistent with deploymentModel.`,
    },
  };
}

// Check 8: Architecture version / hash mismatch
function checkArchVersion(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, implVersion, implHash } = ctx;

  if (!implVersion && !implHash) {
    return {
      violations,
      warnings,
      check: {
        name: "arch-version",
        passed: true,
        details: "No implementation architecture version supplied; skipping version check.",
      },
    };
  }

  if (implVersion && implVersion !== arch.version) {
    violations.push(
      makeFinding(
        "arch-version",
        "architecture-frozen: implementation claims a different architecture version than the frozen contract",
        `Implementation was built under architecture version '${implVersion}' but the frozen contract version is '${arch.version}'.`,
        [],
        "high",
        `Re-run the task against the current frozen architecture (v${arch.version}) or freeze a new version via an Architecture Change Request.`,
      ),
    );
  }

  if (implHash && implHash !== arch.hash) {
    violations.push(
      makeFinding(
        "arch-version",
        "architecture-frozen: implementation claims a different architecture hash than the frozen contract",
        `Implementation was built under architecture hash '${implHash.slice(0, 12)}' but the frozen contract hash is '${arch.hash.slice(0, 12)}'.`,
        [],
        "high",
        `Re-run the task against the current frozen architecture or freeze a new version via an Architecture Change Request.`,
      ),
    );
  }

  const hasViolation = violations.length > 0;
  return {
    violations,
    warnings,
    check: {
      name: "arch-version",
      passed: !hasViolation,
      details: hasViolation
        ? `Implementation architecture version/hash does not match frozen contract.`
        : `Implementation architecture version matches frozen contract (v${arch.version}, ${arch.hash.slice(0, 12)}).`,
    },
  };
}

// Check 9: Required component presence
function checkComponentPresence(ctx: CheckContext): {
  violations: GuardianFinding[];
  warnings: GuardianFinding[];
  check: GuardianCheck;
} {
  const violations: GuardianFinding[] = [];
  const warnings: GuardianFinding[] = [];
  const { arch, changedFiles } = ctx;

  // For each declared component, check if AT LEAST ONE file/dir in the change set
  // corresponds to it. This is a "best effort" check based on component.type and paths.
  // We only flag a violation when we have STRONG evidence the component is missing
  // from the implementation as a whole — but since we only see the diff, we limit
  // our flagging to: declared component with explicit `paths` that don't appear in the diff.
  for (const c of arch.components) {
    const declaredPaths = c.paths || [];
    if (declaredPaths.length === 0) continue;
    const found = declaredPaths.some((p) =>
      changedFiles.some((f) => f.path === p || f.path.startsWith(p + "/") || f.path.startsWith(p)),
    );
    if (!found) {
      // Only flag if the diff touches a "broad" set of files (i.e. likely the initial scaffold).
      // For a single task's diff, not finding every component's path is normal.
      const broadDiff = changedFiles.length > 10;
      if (broadDiff) {
        warnings.push(
          makeFinding(
            "component-presence",
            "component-presence: declared component has no files in the diff",
            `Component '${c.name}' (${c.type}) declares paths [${declaredPaths.join(", ")}] but no files in the change set match.`,
            [],
            "low",
            `Verify the component is implemented in a file outside this diff, or add the missing files.`,
          ),
        );
      }
    }
  }

  return {
    violations,
    warnings,
    check: {
      name: "component-presence",
      passed: violations.length === 0,
      details: `${arch.components.length} component(s) declared; ${warnings.length} presence warning(s).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDeterministicGuardian(
  input: GuardianInput,
): Promise<DeterministicGuardianResult> {
  const ctx: CheckContext = {
    arch: input.architecture,
    changedFiles: input.changedFiles,
    diff: input.diff,
    implVersion: input.implementationArchitectureVersion,
    implHash: input.implementationArchitectureHash,
  };

  const allViolations: GuardianFinding[] = [];
  const allWarnings: GuardianFinding[] = [];
  const checks: GuardianCheck[] = [];

  const c1 = checkDependencies(ctx);
  allViolations.push(...c1.violations); allWarnings.push(...c1.warnings); checks.push(c1.check);

  const c2 = checkForbiddenTech(ctx);
  allViolations.push(...c2.violations); allWarnings.push(...c2.warnings); checks.push(c2.check);

  const c3 = checkApiContracts(ctx);
  allViolations.push(...c3.violations); allWarnings.push(...c3.warnings); checks.push(c3.check);

  const c4 = checkDbSchema(ctx);
  allViolations.push(...c4.violations); allWarnings.push(...c4.warnings); checks.push(c4.check);

  const c5 = checkBoundaries(ctx);
  allViolations.push(...c5.violations); allWarnings.push(...c5.warnings); checks.push(c5.check);

  const c6 = checkEnvVars(ctx);
  allViolations.push(...c6.violations); allWarnings.push(...c6.warnings); checks.push(c6.check);

  const c7 = checkInfra(ctx);
  allViolations.push(...c7.violations); allWarnings.push(...c7.warnings); checks.push(c7.check);

  const c8 = checkArchVersion(ctx);
  allViolations.push(...c8.violations); allWarnings.push(...c8.warnings); checks.push(c8.check);

  const c9 = checkComponentPresence(ctx);
  allViolations.push(...c9.violations); allWarnings.push(...c9.warnings); checks.push(c9.check);

  // Verdict logic:
  //   - any 'high' violation → VIOLATION
  //   - any 'medium'/'low' violation OR any warning → WARNING
  //   - otherwise → PASS
  let verdict: GuardianVerdict = "PASS";
  const hasHigh = allViolations.some((v) => v.severity === "high");
  const hasAnyViolation = allViolations.length > 0;
  const hasAnyWarning = allWarnings.length > 0;
  if (hasHigh) {
    verdict = "VIOLATION";
  } else if (hasAnyViolation || hasAnyWarning) {
    verdict = "WARNING";
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const summary = `Deterministic Guardian: ${verdict}. ${checks.length} checks ran (${passedCount} passed). ${allViolations.length} violation(s), ${allWarnings.length} warning(s).`;

  return {
    verdict,
    violations: allViolations,
    warnings: allWarnings,
    checks,
    summary,
    architectureVersion: input.architecture.version,
    architectureHash: input.architecture.hash,
    checkedAt: new Date().toISOString(),
    filesAnalyzed: input.changedFiles.length,
  };
}

export const GUARDIAN_DETERMINISTIC_VERSION = "1.0.0";
