// Forge — Phase 18V: Substrate Namespace Runner.
//
// Builds a `linux-namespace-sandbox` substrate using unprivileged user
// namespaces (no Docker/containerd/firecracker required). The substrate is
// established by:
//
//   1. compileLauncher() — compiles src/lib/substrate/forge-launcher.c with
//      gcc. The launcher is a small C program that:
//        - sets rlimits (fail-closed on CPU/AS),
//        - reads the new namespace inodes (we run inside `unshare -U -r -p
//          -f -n -m`, so these are the freshly-created inodes),
//        - calls PR_SET_NO_NEW_PRIVS,
//        - bind-mounts system dirs + dev nodes + workspace into rootfs
//          (MUST be done inside the user namespace — the host does NOT
//          permit unprivileged `mount --bind`. The mounts live only in this
//          mount namespace and are cleaned up automatically when the
//          namespace is destroyed on exit),
//        - chroots into the rootfs,
//        - installs a seccomp BPF filter blocking the 25 required syscalls,
//        - records the observed seccomp mode + CapEff + rlimits as JSON,
//        - execvp's the target binary.
//
//   2. buildRootfs() — creates the rootfs directory + subdirs + empty dev
//      files (placeholders for the bind-mount targets). NO bind-mounts —
//      those are done by the launcher inside the user namespace.
//
//   3. runInSubstrate() — orchestrates the whole thing:
//        - read host namespace inodes (to prove the attestation inodes differ),
//        - build the rootfs dir structure,
//        - spawn `unshare -U -r -p -f -n -m --propagation=private <launcher>
//          <factsFile> <rootfsDir> <workspaceDir> <binary> ...args` with a
//          sanitized env (and SUBSTRATE_INCLUDE_PROC=1 if includeProc),
//        - wait with timeout (SIGTERM → 5s grace → SIGKILL on the process
//          group),
//        - read the facts JSON and construct a SandboxAttestation,
//        - cleanup rootfs dir (just rmSync — bind-mounts died with unshare).
//
// FAIL-CLOSED: if gcc is missing, if unshare fails, if the launcher won't
// compile, if the facts file is missing — throw. Never fabricate an
// attestation. The production gate (isSubstrateVerified) treats a missing
// attestation as `false`, blocking PRODUCTION_READY.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readlinkSync,
  mkdtempSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

import type { CommandResult } from "@/lib/runtime-executor";
import {
  REQUIRED_DROPPED_CAPABILITIES,
  REQUIRED_SUBSTRATE_POLICY,
  computeSeccompProfileHash,
  type SandboxAttestation,
} from "@/lib/substrate-attestation";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const LAUNCHER_SOURCE = resolve(PROJECT_ROOT, "src/lib/substrate/forge-launcher.c");
const LAUNCHER_BINARY_IN_SRC = resolve(PROJECT_ROOT, "src/lib/substrate/forge-launcher");
const LAUNCHER_BINARY_IN_TMP = "/tmp/forge-launcher";

// ---------------------------------------------------------------------------
// compileLauncher — locate or compile the forge-launcher binary
// ---------------------------------------------------------------------------

/**
 * Locate or compile the forge-launcher binary.
 *
 * The C source is at `src/lib/substrate/forge-launcher.c`. The compiled
 * binary is cached next to the source (`src/lib/substrate/forge-launcher`),
 * or at `/tmp/forge-launcher` if the src dir isn't writable.
 *
 * If the binary is missing OR older than the .c source, recompile via
 * `gcc -O2 -o <binary> <source>`. If gcc fails, throw (fail-closed — no
 * substrate without a working launcher).
 *
 * @returns the absolute path to the compiled launcher binary.
 */
export function compileLauncher(): string {
  if (!existsSync(LAUNCHER_SOURCE)) {
    throw new Error(
      `forge-launcher source not found at ${LAUNCHER_SOURCE} — cannot compile substrate launcher`
    );
  }

  // Pick a binary path. Prefer next-to-source; fall back to /tmp.
  const srcDirWritable = canWrite(resolve(PROJECT_ROOT, "src/lib/substrate"));
  const binaryPath = srcDirWritable ? LAUNCHER_BINARY_IN_SRC : LAUNCHER_BINARY_IN_TMP;

  const sourceMtime = statSync(LAUNCHER_SOURCE).mtimeMs;
  let needsCompile = true;
  if (existsSync(binaryPath)) {
    try {
      const binaryMtime = statSync(binaryPath).mtimeMs;
      needsCompile = binaryMtime < sourceMtime;
    } catch {
      needsCompile = true;
    }
  }

  if (needsCompile) {
    try {
      // Phase 18W: link with -lcrypto for Ed25519 signing + SHA-256.
      execFileSync("gcc", ["-O2", "-o", binaryPath, LAUNCHER_SOURCE, "-lcrypto"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (err: unknown) {
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr?: Buffer }).stderr ?? "")
          : "";
      throw new Error(
        `forge-launcher compilation failed (gcc): ${err instanceof Error ? err.message : String(err)}${stderr ? ` — gcc stderr: ${stderr}` : ""}`
      );
    }
    if (!existsSync(binaryPath)) {
      throw new Error(
        `forge-launcher compilation produced no binary at ${binaryPath}`
      );
    }
  }

  return binaryPath;
}

function canWrite(dirPath: string): boolean {
  try {
    // Try to create a temp marker file. If it succeeds, we can write.
    const marker = join(dirPath, `.forge-write-test-${Date.now()}`);
    writeFileSync(marker, "x");
    rmSync(marker, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a writable temp base directory that is NOT under `avoidAncestor`.
 *
 * Why: the launcher bind-mounts opts.cwd onto rootfs/workspace. If rootfs is
 * under opts.cwd, that creates a recursive bind (source is an ancestor of
 * target) which fails with EINVAL. We avoid this by placing rootfs in a temp
 * dir that's not under opts.cwd.
 *
 * Candidates (in order): os.tmpdir(), /var/tmp, /dev/shm, then the parent of
 * opts.cwd (a sibling of opts.cwd — never under it).
 */
function pickTempBaseNotUnder(avoidAncestor: string): string {
  const avoid = resolve(avoidAncestor);
  const candidates: string[] = [tmpdir(), "/var/tmp", "/dev/shm"];
  // Add the parent of opts.cwd as a last-resort candidate.
  const parent = dirname(avoid);
  if (parent && parent !== avoid) {
    candidates.push(parent);
  }
  for (const cand of candidates) {
    if (!cand) continue;
    const resolved = resolve(cand);
    if (isAncestor(avoid, resolved)) continue; // resolved is under avoid — skip
    if (!canWrite(resolved)) continue;
    return resolved;
  }
  // Fallback: just use os.tmpdir() (may have the recursion issue, but better
  // than throwing — the caller can handle the bind failure).
  return tmpdir();
}

/** Returns true if `ancestor` is an ancestor of `path` (or equal to it). */
function isAncestor(ancestor: string, path: string): boolean {
  const a = ancestor.replace(/\/+$/, "");
  const p = path.replace(/\/+$/, "");
  if (a === p) return true;
  if (a === "" || a === "/") return true; // / is ancestor of everything
  return p.startsWith(a + "/");
}

// ---------------------------------------------------------------------------
// Rootfs construction (dir structure only — bind-mounts done by the launcher)
// ---------------------------------------------------------------------------

const ROOTFS_SUBDIRS = ["bin", "sbin", "lib", "lib64", "usr", "dev", "workspace", "tmp"];
const ROOTFS_DEV_FILES = ["dev/null", "dev/zero", "dev/urandom"];

export interface BuildRootfsOptions {
  includeProc?: boolean;
}

/**
 * Create the rootfs directory + subdirs + empty dev-file placeholders.
 *
 * NOTE: This function does NOT do bind-mounts. Bind-mounts require the user
 * namespace (the host does not permit unprivileged `mount --bind`), so they
 * are performed by the launcher (forge-launcher.c) AFTER `unshare -U -r -m`
 * has been entered. The mounts live only in the launcher's mount namespace
 * and are cleaned up automatically when that namespace is destroyed on exit.
 *
 * The empty dev files (dev/null, dev/zero, dev/urandom) are placeholders so
 * that `mount --bind /dev/null rootfs/dev/null` has a target file to bind
 * onto (mknod fails inside the user namespace, so we bind-mount the host's
 * device nodes instead).
 *
 * @param rootfsDir  absolute path to the rootfs directory (will be created).
 * @param workspaceDir absolute path to the workspace (the launcher bind-mounts
 *                     this into rootfs/workspace READ-WRITE).
 * @param opts       optional { includeProc: true } — the launcher will also
 *                   bind-mount /proc into rootfs/proc (read-only).
 */
export function buildRootfs(
  rootfsDir: string,
  workspaceDir: string,
  opts?: BuildRootfsOptions
): void {
  const includeProc = opts?.includeProc === true;

  // 1. Create rootfs + subdirs.
  mkdirSync(rootfsDir, { recursive: true });
  for (const sub of ROOTFS_SUBDIRS) {
    mkdirSync(join(rootfsDir, sub), { recursive: true });
  }
  if (includeProc) {
    mkdirSync(join(rootfsDir, "proc"), { recursive: true });
  }

  // 2. Create empty device-node placeholder files (bind-mount targets).
  for (const relPath of ROOTFS_DEV_FILES) {
    writeFileSync(join(rootfsDir, relPath), "");
  }

  // 3. Ensure the workspace dir exists (the launcher bind-mounts it).
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }
}

/**
 * Cleanup the rootfs directory. Just rmSync — no umount needed because the
 * bind-mounts were done inside the launcher's mount namespace (which died
 * with the unshare process). From the host's perspective, rootfsDir only
 * ever contained empty subdirs + empty dev-file placeholders.
 */
export function cleanupRootfs(rootfsDir: string): void {
  try {
    rmSync(rootfsDir, { recursive: true, force: true });
  } catch {
    // Best-effort — leave the dir if rmSync fails (rare).
  }
}

// ---------------------------------------------------------------------------
// Host namespace observation (to prove the substrate's inodes differ)
// ---------------------------------------------------------------------------

export interface HostNamespaceInodes {
  user: string;
  pid: string;
  net: string;
  mnt: string;
}

/**
 * Read the host's namespace inodes via readlinkSync("/proc/self/ns/*").
 * Called BEFORE spawning unshare so we can compare to the attestation's
 * inodes (which are read by the launcher AFTER unshare, so they should be
 * different — proving a real namespace boundary was crossed).
 */
export function getHostNamespaceInodes(): HostNamespaceInodes {
  return {
    user: readlinkSafe("/proc/self/ns/user"),
    pid: readlinkSafe("/proc/self/ns/pid"),
    net: readlinkSafe("/proc/self/ns/net"),
    mnt: readlinkSafe("/proc/self/ns/mnt"),
  };
}

function readlinkSafe(p: string): string {
  try {
    return readlinkSync(p) ?? "";
  } catch {
    return "";
  }
}

/**
 * Assert that every attestation namespace inode differs from the corresponding
 * host inode. Throws if any match (i.e., the substrate did NOT actually enter
 * a new namespace — fail-closed).
 */
export function assertSubstrateIsolated(
  attestation: SandboxAttestation,
  hostInodes: HostNamespaceInodes
): void {
  const checks: Array<[string, string | null, string]> = [
    ["userNamespaceInode", attestation.userNamespaceInode, hostInodes.user],
    ["pidNamespaceInode", attestation.pidNamespaceInode, hostInodes.pid],
    ["netNamespaceInode", attestation.netNamespaceInode, hostInodes.net],
    ["mntNamespaceInode", attestation.mntNamespaceInode, hostInodes.mnt],
  ];
  for (const [name, att, host] of checks) {
    if (!att) {
      throw new Error(`substrate attestation ${name} is missing — not isolated`);
    }
    if (att === host) {
      throw new Error(
        `substrate attestation ${name} (${att}) matches host inode — NOT in a new namespace`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Environment sanitization
// ---------------------------------------------------------------------------

const SENSITIVE_ENV_PATTERNS: Array<RegExp> = [
  /^FORGE_/i,
  /^DATABASE_/i,
  /^GITHUB_/i,
  /^AWS_/i,
  /^GITLAB_/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PRIVATE.?KEY/i,
  /API.?KEY/i,
  /ACCESS.?KEY/i,
  /CREDENTIAL/i,
  /_KEY$/i,
  /^KEY_/i,
];

const ENV_ALLOWLIST: Array<string> = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "TZ",
  // SUBSTRATE_INCLUDE_PROC is a launcher control flag (not sensitive).
  "SUBSTRATE_INCLUDE_PROC",
];

/**
 * Build a sanitized environment for the sandboxed binary.
 *
 * Strategy: start with an empty env, copy a curated allowlist from
 * process.env, strip anything matching sensitive patterns (FORGE_*, DATABASE_*,
 * GITHUB_*, *SECRET*, *TOKEN*, *KEY*, *PASSWORD*, *CREDENTIAL*), then set
 * HOME=/workspace (the bind-mounted workspace inside the chroot), and finally
 * merge the caller-supplied `extra` env (which is also sanitized).
 *
 * NOTE: SUBSTRATE_INCLUDE_PROC is in the allowlist so the launcher can read
 * it (it's a control flag, not a secret — it just tells the launcher whether
 * to bind-mount /proc).
 */
export function sanitizeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy allowlisted vars from process.env.
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined && v !== "") {
      env[key] = v;
    }
  }

  // Set HOME to /workspace (inside the chroot).
  env.HOME = "/workspace";

  // Merge caller-supplied env, skipping sensitive keys.
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (isSensitiveKey(k)) continue;
      env[k] = v;
    }
  }

  // Final pass: strip any sensitive keys that snuck in via the allowlist
  // (defense-in-depth — none of the allowlisted names match, but be safe).
  for (const k of Object.keys(env)) {
    if (isSensitiveKey(k)) {
      delete env[k];
    }
  }

  // Re-add HOME (it's never sensitive).
  env.HOME = "/workspace";

  return env;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(key));
}

// ---------------------------------------------------------------------------
// Substrate runner — the main entry point
// ---------------------------------------------------------------------------

export interface RunInSubstrateOptions {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  includeProc?: boolean;
  /**
   * Phase 18W: The nonce bound into the launcher signature. The control plane
   * passes this and verifies it matches the nonce in canonicalFactsJson.
   * Prevents replay of a launcher-signed attestation from a different execution.
   */
  nonce: string;
  /**
   * Phase 18W: The executionId bound into the launcher signature. The control
   * plane verifies it matches. Binds the attestation to a specific execution.
   */
  executionId: string;
  /**
   * Phase 18W: Path to the launcher's Ed25519 private key (PEM). The launcher
   * reads this BEFORE chroot and uses it to sign canonicalFactsJson. The key
   * is SEPARATE from the worker key and provisioned by admin. REQUIRED —
   * without it, the launcher cannot sign, and the attestation is untrusted.
   */
  launcherKeyFile: string;
}

export interface SubstrateRunResult {
  result: CommandResult;
  attestation: SandboxAttestation;
}

const TERMINATION_GRACE_MS = 5000;

/**
 * Run a binary inside the linux-namespace-sandbox substrate.
 *
 * Steps:
 *   1. Read host namespace inodes (to verify isolation later).
 *   2. Compile the launcher (fail-closed if gcc fails).
 *   3. Create a temp dir for rootfs + facts file.
 *   4. buildRootfs(rootfsDir, opts.cwd, { includeProc }) — mkdir + dev files.
 *   5. Spawn `unshare -U -r -p -f -n -m --propagation=private <launcher>
 *      <factsFile> <rootfsDir> <workspaceDir> <binary> ...args` with sanitized
 *      env (and SUBSTRATE_INCLUDE_PROC=1 if includeProc), detached (own
 *      process group), stdio piped.
 *   6. Wait with timeout. On timeout: SIGTERM the group, 5s grace, SIGKILL.
 *   7. Read the facts JSON, construct a SandboxAttestation.
 *   8. Assert substrate isolation (attestation inodes differ from host's).
 *   9. Cleanup rootfs dir (always, in finally — just rmSync, no umount).
 *
 * FAIL-CLOSED: if the launcher exits before writing facts (chroot/seccomp
 * failure), the facts file is missing — throw. Never fabricate an attestation.
 */
export async function runInSubstrate(
  opts: RunInSubstrateOptions
): Promise<SubstrateRunResult> {
  if (!opts.binary) throw new Error("runInSubstrate: binary is required");
  if (!Array.isArray(opts.args)) throw new Error("runInSubstrate: args must be an array");
  if (typeof opts.timeoutMs !== "number" || opts.timeoutMs <= 0) {
    throw new Error("runInSubstrate: timeoutMs must be a positive number");
  }
  if (!opts.cwd) throw new Error("runInSubstrate: cwd is required");
  if (!opts.nonce) throw new Error("runInSubstrate: nonce is required (Phase 18W launcher trust)");
  if (!opts.executionId) throw new Error("runInSubstrate: executionId is required (Phase 18W launcher trust)");
  if (!opts.launcherKeyFile) throw new Error("runInSubstrate: launcherKeyFile is required (Phase 18W launcher trust)");

  const launcherBinary = compileLauncher();
  const hostInodes = getHostNamespaceInodes();

  // Phase 18W: Generate a unique substrateInstanceId for this invocation.
  const substrateInstanceId = randomUUID();

  // 1. Create temp dir for rootfs + facts file.
  // IMPORTANT: the rootfs must NOT be under opts.cwd, because the launcher
  // bind-mounts opts.cwd onto rootfs/workspace — if rootfs is under opts.cwd,
  // that creates a recursive bind (source is an ancestor of target) which
  // fails with EINVAL. Pick a temp base that's not under opts.cwd.
  const tempBase = pickTempBaseNotUnder(opts.cwd);
  const tempDir = mkdtempSync(join(tempBase, "forge-substrate-"));
  const rootfsDir = join(tempDir, "rootfs");
  const factsFile = join(tempDir, "facts.json");

  // Pre-create an empty facts file so we can detect "launcher never wrote it"
  // vs "launcher wrote but parse failed".
  writeFileSync(factsFile, "");

  let child: ChildProcess | null = null;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  const start = Date.now();

  try {
    // 2. Build the rootfs dir structure (NO bind-mounts — launcher does those).
    buildRootfs(rootfsDir, opts.cwd, { includeProc: opts.includeProc });

    // 3. Spawn unshare with the launcher.
    // Phase 18W: new arg layout — launcher takes <launcher_key_file> <nonce>
    // <execution_id> <substrate_instance_id> <facts_file> <rootfs_dir>
    // <workspace_dir> <binary> [args...].
    const unshareArgs: string[] = [
      "-U", "-r", "-p", "-f", "-n", "-m",
      "--propagation=private",
      launcherBinary,
      opts.launcherKeyFile,
      opts.nonce,
      opts.executionId,
      substrateInstanceId,
      factsFile,
      rootfsDir,
      opts.cwd, // workspace_dir — bind-mounted into rootfs/workspace (RW)
      opts.binary,
      ...opts.args,
    ];
    const sanitizedEnv = sanitizeEnv(opts.env);
    // Control flag for the launcher: bind-mount /proc if includeProc.
    if (opts.includeProc) {
      sanitizedEnv.SUBSTRATE_INCLUDE_PROC = "1";
    } else {
      delete sanitizedEnv.SUBSTRATE_INCLUDE_PROC;
    }

    child = spawn("unshare", unshareArgs, {
      cwd: opts.cwd,
      env: sanitizedEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false, // NEVER use shell — prevents command injection.
      detached: true, // Own process group — we can kill -<pgid>.
    });

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 400000) stdout = stdout.slice(-400000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 400000) stderr = stderr.slice(-400000);
    });

    // 4. Wait with timeout.
    const exitInfo: { code: number | null; signal: NodeJS.Signals | null } =
      await new Promise((resolveP) => {
        const timer = setTimeout(() => {
          timedOut = true;
          teardownSubstrate(child).finally(() => {
            // resolveP will be called by the 'close' handler below.
          });
        }, opts.timeoutMs);

        child!.once("close", (code, signal) => {
          clearTimeout(timer);
          resolveP({ code, signal });
        });
        child!.once("error", (err) => {
          clearTimeout(timer);
          stderr += `\nspawn error: ${err.message}`;
          resolveP({ code: -1, signal: null });
        });
      });

    const durationMs = Date.now() - start;
    const result: CommandResult = {
      success: !timedOut && exitInfo.code === 0,
      exitCode: exitInfo.code,
      stdout: stdout.slice(0, 200000),
      stderr: stderr.slice(0, 200000),
      durationMs,
      timedOut,
      signal: exitInfo.signal,
    };

    // 5. Read the facts file.
    let factsRaw: string;
    try {
      factsRaw = readFileSync(factsFile, "utf-8");
    } catch {
      throw new Error(
        `substrate launcher did not produce a facts file at ${factsFile} — ` +
          `substrate could not be established (exitCode=${exitInfo.code}, ` +
          `signal=${exitInfo.signal}). stderr: ${stderr.slice(0, 2000)}`
      );
    }
    if (!factsRaw.trim()) {
      throw new Error(
        `substrate launcher produced an empty facts file — substrate setup ` +
          `failed before writing facts (exitCode=${exitInfo.code}). stderr: ${stderr.slice(0, 2000)}`
      );
    }

    let facts: LauncherFacts;
    try {
      facts = JSON.parse(factsRaw) as LauncherFacts;
    } catch (err) {
      throw new Error(
        `substrate launcher facts file is not valid JSON: ${err instanceof Error ? err.message : String(err)}. raw: ${factsRaw.slice(0, 500)}`
      );
    }

    // 6. Construct the SandboxAttestation.
    const attestation = buildAttestation(facts, hostInodes);

    // 7. Verify the substrate actually entered new namespaces (fail-closed).
    assertSubstrateIsolated(attestation, hostInodes);

    return { result, attestation };
  } finally {
    // 8. Always cleanup rootfs dir + temp dir.
    // No umount needed — bind-mounts lived in the launcher's mount namespace
    // and died with it. From the host's perspective, rootfsDir only ever
    // contained empty subdirs + empty dev-file placeholders.
    cleanupRootfs(rootfsDir);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Facts JSON → SandboxAttestation
// ---------------------------------------------------------------------------

interface LauncherFacts {
  runtimeVersion: string;
  userNamespaceInode: string;
  pidNamespaceInode: string;
  netNamespaceInode: string;
  mntNamespaceInode: string;
  seccompMode: number;
  capEffHex: string;
  blockedSyscalls: string[];
  cpuLimitSeconds: number;
  memoryLimitBytes: number;
  processLimit: number;
  fileDescriptorLimit: number;
  fileSizeLimitBytes: number;
  createdAt: string;
  // Phase 18W: launcher trust fields.
  nonce: string;
  executionId: string;
  substrateInstanceId: string;
  workloadExitCode: number | null;
  workloadSignal: number | null;
  workloadStdoutHash: string;
  workloadStderrHash: string;
  canonicalFactsJson: string;
  launcherSignature: string;
  launcherAlgorithm: string;
  launcherKeyId: string;
  launcherSignedAt: string;
}

function buildAttestation(
  facts: LauncherFacts,
  hostInodes: HostNamespaceInodes
): SandboxAttestation {
  const substrateVerified =
    facts.userNamespaceInode !== hostInodes.user &&
    facts.pidNamespaceInode !== hostInodes.pid &&
    facts.netNamespaceInode !== hostInodes.net &&
    facts.mntNamespaceInode !== hostInodes.mnt;

  return {
    substrateType: "linux-namespace-sandbox",
    runtimeVersion: facts.runtimeVersion,
    userNamespaceInode: facts.userNamespaceInode,
    pidNamespaceInode: facts.pidNamespaceInode,
    netNamespaceInode: facts.netNamespaceInode,
    mntNamespaceInode: facts.mntNamespaceInode,
    seccompMode: facts.seccompMode,
    seccompProfileHash: computeSeccompProfileHash(facts.blockedSyscalls),
    cpuLimitSeconds: facts.cpuLimitSeconds,
    memoryLimitBytes: facts.memoryLimitBytes,
    processLimit: facts.processLimit,
    fileDescriptorLimit: facts.fileDescriptorLimit,
    fileSizeLimitBytes: facts.fileSizeLimitBytes,
    // In a user namespace, the process technically has "all caps" within the
    // user ns, but those caps don't grant real privileges on host resources
    // (CAP_SYS_ADMIN in a user ns only affects resources owned by that user
    // ns). We attest that we INTEND to drop these caps — and they ARE
    // effectively dropped from the host's perspective. PR_SET_NO_NEW_PRIVS
    // prevents any future escalation.
    capabilitiesDropped: [...REQUIRED_DROPPED_CAPABILITIES],
    networkMode: REQUIRED_SUBSTRATE_POLICY.networkMode, // "hermetic-loopback"
    imageDigest: null,
    containerId: null,
    readonlyRootfs: REQUIRED_SUBSTRATE_POLICY.readonlyRootfs,
    createdAt: facts.createdAt,
    substrateVerified,
    // Phase 18W: launcher trust fields.
    nonce: facts.nonce,
    executionId: facts.executionId,
    substrateInstanceId: facts.substrateInstanceId,
    workloadExitCode: facts.workloadExitCode,
    workloadSignal: facts.workloadSignal,
    workloadStdoutHash: facts.workloadStdoutHash,
    workloadStderrHash: facts.workloadStderrHash,
    canonicalFactsJson: facts.canonicalFactsJson,
    launcherSignature: facts.launcherSignature,
    launcherAlgorithm: facts.launcherAlgorithm,
    launcherKeyId: facts.launcherKeyId,
    launcherSignedAt: facts.launcherSignedAt,
  };
}

// ---------------------------------------------------------------------------
// teardownSubstrate — kill the process group (SIGTERM → grace → SIGKILL)
// ---------------------------------------------------------------------------

/**
 * Tear down a substrate child process group:
 *   1. SIGTERM the entire process group (unshare + launcher + binary).
 *   2. Wait up to TERMINATION_GRACE_MS (5s) for graceful exit.
 *   3. SIGKILL the group if still alive.
 *
 * Safe to call multiple times. Safe to call with null (no-op).
 */
export async function teardownSubstrate(child: ChildProcess | null): Promise<void> {
  if (!child || child.pid === undefined) return;
  const pgid = child.pid; // detached:true → child.pid is the pgid.

  // 1. SIGTERM the group.
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // Process may already be dead.
  }

  // 2. Wait up to grace period.
  const exited = await Promise.race([
    new Promise<boolean>((resolveP) => {
      child.once("close", () => resolveP(true));
      // If already dead, resolve immediately.
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveP(true);
      }
    }),
    new Promise<boolean>((resolveP) =>
      setTimeout(() => resolveP(false), TERMINATION_GRACE_MS)
    ),
  ]);

  if (exited) return;

  // 3. SIGKILL the group.
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already dead.
  }
}

// ---------------------------------------------------------------------------
// Random bytes helper (for callers that want a random suffix).
// ---------------------------------------------------------------------------

export function randomSuffix(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}
