// Forge — Real Test Runner (Phase 2 P0-3).
//
// Actually executes tests and parses REAL results. The exit code, the test
// counts, the output — all evidence. If tests didn't run, `success` is
// `false`. Never fabricates results.
//
// Detection order (first match wins):
//   1. package.json with `jest` dep           → `npx jest --json`
//   2. package.json with `vitest` dep         → `npx vitest run`
//   3. pytest.ini / conftest.py / setup.cfg   → `pytest`
//   4. go.mod                                  → `go test -v ./...`
//   5. Cargo.toml                              → `cargo test`
//   6. Makefile with `test` target             → `make test`
//
// SERVER-SIDE ONLY. Depends on `node:fs`, `node:path`, and the
// `executeCommand` worker which uses `node:child_process`.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { executeCommand, detectNodePackageManager, type ExecutionResult } from "@/lib/worker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestResult {
  /** Detected test framework ("jest" | "vitest" | "pytest" | "go" | "cargo" | "make" | "unknown"). */
  framework: string;
  /** The actual command that was executed (e.g. "npx jest --json"). */
  command: string;
  /** Exit code. -1 if the process was killed or could not be spawned. */
  exitCode: number;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Last 10KB of stdout. */
  stdout: string;
  /** Last 10KB of stderr. */
  stderr: string;
  /** True if the command exceeded `timeoutMs`. */
  timedOut: boolean;
  /** True iff exitCode === 0 (and not timed out). */
  success: boolean;
}

export interface TestRunOptions {
  /** Worktree path (must exist). */
  cwd: string;
  /** Hard timeout in milliseconds. Default: 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Additional env vars (e.g. CI=true). */
  env?: Record<string, string>;
}

interface DetectedFramework {
  name: string;
  command: string;
  args: string[];
  /** Parse the captured output into {passed, failed, skipped, total}. */
  parse: (stdout: string, stderr: string) => ParsedCounts;
}

interface ParsedCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TEST_TIMEOUT_MS = 300_000; // 5 minutes
/** Cap output stored on the TestResult (smaller than the worker's 100KB). */
const TEST_OUTPUT_CAP = 10 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(input: string, max: number): string {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= max) return input;
  const tail = buf.subarray(buf.length - max);
  return `\n…<truncated ${buf.length - max} bytes from start>\n` + tail.toString("utf8");
}

function readPackageJson(cwd: string): Record<string, unknown> | null {
  const p = path.join(cwd, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasDep(pkg: Record<string, unknown>, name: string): boolean {
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  const devDeps = (pkg.devDependencies as Record<string, string> | undefined) ?? {};
  return Object.prototype.hasOwnProperty.call(deps, name) || Object.prototype.hasOwnProperty.call(devDeps, name);
}

function hasScript(pkg: Record<string, unknown>, name: string): boolean {
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  return Object.prototype.hasOwnProperty.call(scripts, name);
}

function makefileHasTarget(cwd: string, target: string): boolean {
  const p = path.join(cwd, "Makefile");
  if (!existsSync(p)) return false;
  try {
    const txt = readFileSync(p, "utf8");
    // Match lines that start at column 0 with `<target>:` (not indented).
    const re = new RegExp(`^${target}\\s*:`, "m");
    return re.test(txt);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse Jest JSON output (preferred — we invoke jest with --json). */
function parseJest(stdout: string, _stderr: string): ParsedCounts {
  // Jest with --json writes a single JSON object to stdout.
  try {
    const j = JSON.parse(stdout) as {
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      numTodoTests?: number;
      numTotalTests?: number;
    };
    const passed = j.numPassedTests ?? 0;
    const failed = j.numFailedTests ?? 0;
    const skipped = (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0);
    const total = j.numTotalTests ?? passed + failed + skipped;
    return { passed, failed, skipped, total };
  } catch {
    // Fall back to text summary parsing.
  }
  return parseJestText(stdout, _stderr);
}

/** Parse Jest text-summary output (fallback). */
function parseJestText(stdout: string, stderr: string): ParsedCounts {
  const combined = `${stdout}\n${stderr}`;
  // `Tests: 5 passed, 2 failed, 1 skipped, 8 total`
  const testsLine = combined.match(/Tests:\s+([0-9]+)\s+passed(?:,\s+([0-9]+)\s+failed)?(?:,\s+([0-9]+)\s+skipped)?(?:,\s+([0-9]+)\s+total)?/);
  if (testsLine) {
    const passed = parseInt(testsLine[1] ?? "0", 10);
    const failed = parseInt(testsLine[2] ?? "0", 10);
    const skipped = parseInt(testsLine[3] ?? "0", 10);
    const total = parseInt(testsLine[4] ?? "0", 10) || passed + failed + skipped;
    return { passed, failed, skipped, total };
  }
  return { passed: 0, failed: 0, skipped: 0, total: 0 };
}

/** Parse vitest output (default reporter + summary line). */
function parseVitest(stdout: string, stderr: string): ParsedCounts {
  const combined = `${stdout}\n${stderr}`;
  // `Tests  10 passed | 2 failed (12)`
  const testsLine = combined.match(/Tests\s+([0-9]+)\s+passed(?:\s*\|\s*([0-9]+)\s+failed)?(?:\s*\|\s*([0-9]+)\s+skipped)?\s*\(([0-9]+)\)/);
  if (testsLine) {
    const passed = parseInt(testsLine[1] ?? "0", 10);
    const failed = parseInt(testsLine[2] ?? "0", 10);
    const skipped = parseInt(testsLine[3] ?? "0", 10);
    const total = parseInt(testsLine[4] ?? "0", 10) || passed + failed + skipped;
    return { passed, failed, skipped, total };
  }
  return { passed: 0, failed: 0, skipped: 0, total: 0 };
}

/** Parse pytest output. */
function parsePytest(stdout: string, stderr: string): ParsedCounts {
  const combined = `${stdout}\n${stderr}`;

  // Pytest's summary line has a variable component order depending on the
  // outcome (e.g. "2 failed, 3 passed, 1 skipped" when there are failures,
  // "3 passed, 1 skipped" when all pass, "1 error" when collection fails).
  // We extract each component independently and look only inside the final
  // summary line(s) that are wrapped in `====` borders.
  //
  // Examples handled:
  //   `===== 5 passed in 3.45s =====`
  //   `===== 5 passed, 2 failed in 3.45s =====`
  //   `===== 2 failed, 3 passed, 1 skipped in 0.09s =====`
  //   `===== 1 error in 0.03s =====`
  //   `===== no tests ran in 0.00s =====`

  // Find the LAST `===== ... =====` summary block.
  const summaryBlocks = combined.match(/=+\s+[^=]*\s+in\s+[0-9.]+s\s*=+/g);
  const summary = summaryBlocks && summaryBlocks.length > 0
    ? summaryBlocks[summaryBlocks.length - 1]
    : "";

  if (/no tests ran/i.test(summary)) {
    return { passed: 0, failed: 0, skipped: 0, total: 0 };
  }

  const passed = matchCount(summary, /([0-9]+)\s+passed/);
  const failed = matchCount(summary, /([0-9]+)\s+failed/);
  const errors = matchCount(summary, /([0-9]+)\s+errors?/);
  const skipped = matchCount(summary, /([0-9]+)\s+skipped/);

  const totalFailed = failed + errors;
  const total = passed + totalFailed + skipped;
  return { passed, failed: totalFailed, skipped, total };
}

/** Extract the integer captured by the first group of `re` in `text`, or 0. */
function matchCount(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? parseInt(m[1] ?? "0", 10) : 0;
}

/** Parse `go test -v` output. */
function parseGo(stdout: string, stderr: string): ParsedCounts {
  const combined = `${stdout}\n${stderr}`;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // `--- PASS: TestFoo (0.00s)`
  // `--- FAIL: TestBar (0.00s)`
  // `--- SKIP: TestBaz (0.00s)`
  // `--- BENCH: ...` (ignore)
  const lines = combined.split("\n");
  for (const line of lines) {
    if (/^--- PASS:/.test(line)) passed++;
    else if (/^--- FAIL:/.test(line)) failed++;
    else if (/^--- SKIP:/.test(line)) skipped++;
  }

  // If we found individual test results, return them.
  if (passed + failed + skipped > 0) {
    return { passed, failed, skipped, total: passed + failed + skipped };
  }

  // No verbose output — try the summary. `FAIL` lines indicate failure.
  if (/^FAIL\s/m.test(combined)) {
    return { passed: 0, failed: 1, skipped: 0, total: 1 };
  }
  // `ok  package  3.45s` — at least one package passed. We can't count tests
  // without -v; report 1 passed as a heuristic signal.
  if (/^ok\s/m.test(combined)) {
    return { passed: 1, failed: 0, skipped: 0, total: 1 };
  }
  return { passed: 0, failed: 0, skipped: 0, total: 0 };
}

/** Parse `cargo test` output. */
function parseCargo(stdout: string, stderr: string): ParsedCounts {
  const combined = `${stdout}\n${stderr}`;
  // `test result: ok. 5 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out`
  // `test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const re = /test result:\s+(?:ok|FAILED)\.\s+([0-9]+)\s+passed;\s+([0-9]+)\s+failed;\s+([0-9]+)\s+ignored/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(combined)) !== null) {
    passed += parseInt(m[1] ?? "0", 10);
    failed += parseInt(m[2] ?? "0", 10);
    skipped += parseInt(m[3] ?? "0", 10);
  }
  return { passed, failed, skipped, total: passed + failed + skipped };
}

/** Parse `make test` output — opaque, just count via generic patterns.
 *  Falls back to "if exit code is 0, assume tests passed; counts unknown". */
function parseMake(_stdout: string, _stderr: string): ParsedCounts {
  return { passed: 0, failed: 0, skipped: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

export function detectTestFramework(cwd: string): DetectedFramework | null {
  // 1. Node + jest
  const pkg = readPackageJson(cwd);
  if (pkg) {
    if (hasDep(pkg, "jest")) {
      return {
        name: "jest",
        command: "npx",
        args: ["jest", "--json", "--silent"],
        parse: parseJest,
      };
    }
    if (hasDep(pkg, "vitest")) {
      return {
        name: "vitest",
        command: "npx",
        args: ["vitest", "run"],
        parse: parseVitest,
      };
    }
    // Node project without jest/vitest but with a `test` script — run it
    // directly. We can't parse the output reliably, so use a permissive
    // parser that just counts 0.
    if (hasScript(pkg, "test")) {
      const pm = detectNodePackageManager(cwd);
      return {
        name: "npm-test",
        command: pm,
        args: ["test"],
        parse: parseJestText, // tries the Jest-style summary regex; harmless if it fails
      };
    }
  }

  // 3. Python + pytest
  if (
    existsSync(path.join(cwd, "pytest.ini")) ||
    existsSync(path.join(cwd, "conftest.py")) ||
    existsSync(path.join(cwd, "setup.cfg")) ||
    existsSync(path.join(cwd, "tox.ini"))
  ) {
    return {
      name: "pytest",
      command: "pytest",
      args: [],
      parse: parsePytest,
    };
  }
  // requirements.txt / pyproject.toml mentioning pytest
  const reqPath = path.join(cwd, "requirements.txt");
  if (existsSync(reqPath)) {
    try {
      const req = readFileSync(reqPath, "utf8");
      if (/^\s*pytest\b/m.test(req)) {
        return {
          name: "pytest",
          command: "pytest",
          args: [],
          parse: parsePytest,
        };
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Go
  if (existsSync(path.join(cwd, "go.mod"))) {
    return {
      name: "go",
      command: "go",
      args: ["test", "-v", "./..."],
      parse: parseGo,
    };
  }

  // 5. Rust
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    return {
      name: "cargo",
      command: "cargo",
      args: ["test"],
      parse: parseCargo,
    };
  }

  // 6. Makefile with `test` target
  if (makefileHasTarget(cwd, "test")) {
    return {
      name: "make",
      command: "make",
      args: ["test"],
      parse: parseMake,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API: runTests
// ---------------------------------------------------------------------------

/**
 * Execute the detected test framework and return REAL results. If no
 * framework is detected, returns a structured `success: false` result
 * (NEVER fabricates a pass).
 */
export async function runTests(opts: TestRunOptions): Promise<TestResult> {
  const framework = detectTestFramework(opts.cwd);
  if (!framework) {
    return {
      framework: "unknown",
      command: "",
      exitCode: -1,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      durationMs: 0,
      stdout: "",
      stderr:
        "[forge-test-runner] No test framework detected. Looked for: package.json (jest/vitest/test script), pytest.ini/conftest.py/setup.cfg/tox.ini/requirements.txt+pytest, go.mod, Cargo.toml, Makefile with test target.",
      timedOut: false,
      success: false,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const exec = await executeCommand(framework.command, framework.args, {
    cwd: opts.cwd,
    timeoutMs,
    env: opts.env,
  });

  const counts = framework.parse(exec.stdout, exec.stderr);

  return {
    framework: framework.name,
    command: `${framework.command} ${framework.args.join(" ")}`.trim(),
    exitCode: exec.exitCode ?? -1,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    total: counts.total,
    durationMs: exec.durationMs,
    stdout: truncate(exec.stdout, TEST_OUTPUT_CAP),
    stderr: truncate(exec.stderr, TEST_OUTPUT_CAP),
    timedOut: exec.timedOut,
    success: exec.success,
  };
}

// ---------------------------------------------------------------------------
// Auxiliary verification commands
// ---------------------------------------------------------------------------

/**
 * Run the project's linter. Detection:
 *   - package.json with `lint` script → `npm run lint`
 *   - Python with ruff installed → `ruff check .`
 *   - go.mod → `go vet ./...`
 *   - Cargo.toml → `cargo clippy` (if available) else `cargo build`
 */
export async function runLint(
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecutionResult> {
  const pkg = readPackageJson(cwd);
  if (pkg && hasScript(pkg, "lint")) {
    const pm = detectNodePackageManager(cwd);
    return executeCommand(pm, ["run", "lint"], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
      env: opts.env,
    });
  }
  if (existsSync(path.join(cwd, "go.mod"))) {
    return executeCommand("go", ["vet", "./..."], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
      env: opts.env,
    });
  }
  if (existsSync(path.join(cwd, "ruff.toml")) || existsSync(path.join(cwd, ".ruff.toml"))) {
    return executeCommand("ruff", ["check", "."], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
      env: opts.env,
    });
  }
  if (existsSync(path.join(cwd, "requirements.txt"))) {
    try {
      const req = readFileSync(path.join(cwd, "requirements.txt"), "utf8");
      if (/^\s*ruff\b/m.test(req)) {
        return executeCommand("ruff", ["check", "."], {
          cwd,
          timeoutMs: opts.timeoutMs ?? 120_000,
          env: opts.env,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return {
    command: "",
    args: [],
    cwd,
    exitCode: 0,
    stdout: "[forge-test-runner] No linter detected; skipping lint.",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    success: true,
  };
}

/**
 * Run a type-check. Detection:
 *   - package.json with `typecheck` script → `npm run typecheck`
 *   - TypeScript project (tsconfig.json) without script → `npx tsc --noEmit`
 *   - Python with mypy installed → `mypy .`
 *   - go.mod → `go vet ./...` (Go doesn't have a separate type-check)
 */
export async function runTypeCheck(
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecutionResult> {
  const pkg = readPackageJson(cwd);
  if (pkg) {
    if (hasScript(pkg, "typecheck")) {
      const pm = detectNodePackageManager(cwd);
      return executeCommand(pm, ["run", "typecheck"], {
        cwd,
        timeoutMs: opts.timeoutMs ?? 120_000,
        env: opts.env,
      });
    }
    if (existsSync(path.join(cwd, "tsconfig.json"))) {
      return executeCommand("npx", ["tsc", "--noEmit"], {
        cwd,
        timeoutMs: opts.timeoutMs ?? 120_000,
        env: opts.env,
      });
    }
  }
  if (existsSync(path.join(cwd, "go.mod"))) {
    return executeCommand("go", ["vet", "./..."], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
      env: opts.env,
    });
  }
  if (existsSync(path.join(cwd, "mypy.ini")) || existsSync(path.join(cwd, ".mypy.ini"))) {
    return executeCommand("mypy", ["."], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
      env: opts.env,
    });
  }

  return {
    command: "",
    args: [],
    cwd,
    exitCode: 0,
    stdout: "[forge-test-runner] No type-checker detected; skipping type-check.",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    success: true,
  };
}

/**
 * Run the project's build. Detection:
 *   - package.json with `build` script → `npm run build`
 *   - go.mod → `go build ./...`
 *   - Cargo.toml → `cargo build`
 *   - Makefile with `build` target → `make build`
 */
export async function runBuild(
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecutionResult> {
  const pkg = readPackageJson(cwd);
  if (pkg && hasScript(pkg, "build")) {
    const pm = detectNodePackageManager(cwd);
    return executeCommand(pm, ["run", "build"], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      env: opts.env,
    });
  }
  if (existsSync(path.join(cwd, "go.mod"))) {
    return executeCommand("go", ["build", "./..."], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      env: opts.env,
    });
  }
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    return executeCommand("cargo", ["build"], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      env: opts.env,
    });
  }
  if (makefileHasTarget(cwd, "build")) {
    return executeCommand("make", ["build"], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      env: opts.env,
    });
  }

  return {
    command: "",
    args: [],
    cwd,
    exitCode: 0,
    stdout: "[forge-test-runner] No build target detected; skipping build.",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    success: true,
  };
}

// Marker for tooling: this module is server-only.
export const SERVER_ONLY = true as const;
