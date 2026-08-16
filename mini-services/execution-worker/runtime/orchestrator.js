/*
 * Forge — Phase 18W-B / 18Z-A: In-substrate runtime verification orchestrator.
 *
 * This is a SELF-CONTAINED Node.js script that runs INSIDE the substrate (the
 * launcher exec's it after chroot+seccomp). It uses ONLY Node.js built-in
 * modules — no npm dependencies — so it can run in the minimal rootfs.
 *
 * It reads /workspace/plan.json (RuntimeVerificationPlan in JSON form),
 * executes the full runtime verification pipeline, and writes
 * /workspace/results.json. Exits 0 if all required checks passed, 1 otherwise.
 *
 * Pipeline:
 *   1. Read /workspace/plan.json.
 *   2. Bring loopback interface up (the fresh net namespace starts with lo DOWN).
 *   3. Run install: spawnSync(plan.install.binary, plan.install.args, { cwd: '/workspace/repo', ... }).
 *   4. Run build: same pattern.
 *   5. Start the app: spawn(plan.start.binary, plan.start.args, { cwd: '/workspace/repo', env: plan.start.env, stdio: 'pipe' }).
 *   6. Wait for the port: poll net.connect(port, '127.0.0.1') until success or startupTimeoutMs.
 *   7. Run health checks: http.get('http://127.0.0.1:' + port + check.path).
 *   8. Run API journeys: http.request() for each step.
 *   9. Stop the app: child.kill('SIGTERM') → 5s grace → child.kill('SIGKILL').
 *  10. Write /workspace/results.json.
 *  11. Exit 0 if passed, 1 otherwise.
 *
 * FAIL-CLOSED: if install fails, skip build/start. If start fails, skip
 * health/journeys. Always write results.json and tear down the app.
 *
 * PHASE 18Z-A — ARTIFACT CAPTURE:
 * The orchestrator ALSO writes per-stage log files to /workspace/logs/.
 * The launcher (forge-launcher.c) walks /workspace/logs/ after the
 * orchestrator exits, hashes each file, and builds the ArtifactManifest.
 * The manifest is then signed by the launcher (with the same Ed25519 key
 * that signs the substrate attestation) and written to /workspace/manifest.json.
 *
 * Log files written (the launcher expects these to be present for the
 * manifest to satisfy REQUIRED_ARTIFACT_TYPES):
 *   /workspace/logs/source-materialization.txt   (git ls-tree HEAD output)
 *   /workspace/logs/install.log                   (install stdout + stderr)
 *   /workspace/logs/build.log                     (build stdout + stderr)
 *   /workspace/logs/startup.log                   (app startup output)
 *   /workspace/logs/health-trace-N.json           (per health check)
 *   /workspace/logs/api-journey-N.json            (per API journey)
 *   /workspace/logs/runtime-stdout.log            (app's full stdout)
 *   /workspace/logs/runtime-stderr.log            (app's full stderr)
 *   /workspace/logs/crash-output.log              (if the app crashed)
 *   /workspace/logs/dependency-lockfile.json      (package-lock.json content, if present)
 *   /workspace/logs/test-results.json             (test output, if any)
 *
 * The launcher (forge-launcher.c) observes this script's stdout/stderr and
 * signs the substrate attestation with its Ed25519 key. The attestation binds
 * the workload (this script) to the substrate facts.
 */

'use strict';

const { spawnSync, spawn, execFileSync } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PLAN_PATH = '/workspace/plan.json';
const RESULTS_PATH = '/workspace/results.json';
const REPO_DIR = '/workspace/repo';
const LOGS_DIR = '/workspace/logs';
const GRACE_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/**
 * Phase 18Z-A: write a log file to /workspace/logs/<name>. Best-effort —
 * errors are swallowed (the orchestrator must not crash if logging fails).
 * Creates the logs dir if it doesn't exist.
 */
function writeLogFile(name, content) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(LOGS_DIR, name), content);
  } catch (err) {
    process.stderr.write('orchestrator: FAILED to write log file ' + name + ': ' + (err && err.message || err) + '\n');
  }
}

/**
 * Phase 18Z-A: write the source-materialization artifact. Records
 * `git ls-tree HEAD` output (the file list at the checked-out SHA). The
 * launcher hashes this file for the source-materialization manifest entry.
 */
function writeSourceMaterialization() {
  try {
    const out = spawnSync('git', ['-C', REPO_DIR, 'ls-tree', '-r', 'HEAD'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    const tree = out.status === 0 ? (out.stdout || '') : ('git ls-tree failed: ' + (out.stderr || ''));
    writeLogFile('source-materialization.txt', tree);
  } catch (err) {
    writeLogFile('source-materialization.txt', 'git ls-tree threw: ' + (err && err.message || err));
  }
}

/**
 * Phase 18Z-A: write the dependency-lockfile artifact. Reads the lockfile
 * from the repo (if present) and writes it to logs/dependency-lockfile.json.
 * Best-effort — if no lockfile is present, writes a small placeholder.
 */
function writeDependencyLockfile() {
  const candidates = [
    'package-lock.json', 'bun.lockb', 'bun.lock', 'yarn.lock',
    'pnpm-lock.yaml', 'poetry.lock', 'Cargo.lock', 'go.sum',
  ];
  for (const c of candidates) {
    try {
      const p = path.join(REPO_DIR, c);
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p);
        writeLogFile('dependency-lockfile.json', content);
        return;
      }
    } catch { /* try next */ }
  }
  writeLogFile('dependency-lockfile.json', JSON.stringify({ note: 'no lockfile found in repo', candidates }));
}

function writeResults(results) {
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  } catch (err) {
    // Last-resort: write to stderr so the launcher captures it. The launcher
    // always writes a facts file; we can't avoid that. But our results file
    // is what the worker reads to construct the evidence envelope.
    process.stderr.write('orchestrator: FAILED to write results.json: ' + err.message + '\n');
  }
}

/**
 * Run a synchronous stage (install or build) using spawnSync. Captures stdout,
 * stderr, exitCode, duration.
 */
function runSyncStage(stage, defaultEnv) {
  if (!stage || !stage.binary) {
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: 'stage binary missing',
      durationMs: 0,
      error: 'stage binary missing',
    };
  }
  const env = Object.assign({}, defaultEnv, stage.env || {});
  const start = Date.now();
  let result;
  try {
    result = spawnSync(stage.binary, stage.args || [], {
      cwd: REPO_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: stage.timeoutMs || 600000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    return {
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: String(err && err.message || err),
      durationMs: Date.now() - start,
      error: String(err && err.message || err),
    };
  }
  const durationMs = Date.now() - start;
  const stdout = (result.stdout || '').slice(0, 50000);
  const stderr = (result.stderr || '').slice(0, 50000);
  const exitCode = result.status;
  const success = exitCode === 0;
  let error = null;
  if (result.error) error = String(result.error.message || result.error);
  if (result.signal) error = `killed by signal ${result.signal}`;
  return { success, exitCode, stdout, stderr, durationMs, error };
}

/**
 * Start the application server. Returns the child process plus startup info.
 */
function startApp(startSpec, defaultEnv) {
  const env = Object.assign({}, defaultEnv, startSpec.env || {});
  const child = spawn(startSpec.binary, startSpec.args || [], {
    cwd: REPO_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
    if (stdout.length > 100000) stdout = stdout.slice(-100000);
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 100000) stderr = stderr.slice(-100000);
  });
  return { child, stdout, stderr };
}

/**
 * Wait for the port to be reachable. Polls net.connect every 100ms.
 */
function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        resolve({ success: false, durationMs: Date.now() - start, error: `port ${port} not reachable within ${timeoutMs}ms` });
        return;
      }
      const socket = net.connect({ port, host: '127.0.0.1' }, () => {
        socket.end();
        socket.destroy();
        resolve({ success: true, durationMs: Date.now() - start });
      });
      socket.on('error', () => {
        setTimeout(attempt, 100);
      });
    }
    attempt();
  });
}

/**
 * Run a single health check. http.get(path), compare status.
 */
function runHealthCheck(port, check) {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = `http://127.0.0.1:${port}${check.path}`;
    const req = http.get(url, (res) => {
      // Drain the body so the socket can be reused/closed.
      let body = '';
      res.on('data', (d) => { body += d.toString(); if (body.length > 50000) body = body.slice(-50000); });
      res.on('end', () => {
        const responseTimeMs = Date.now() - start;
        const passed = res.statusCode === check.expectedStatus;
        resolve({
          name: check.name,
          path: check.path,
          passed,
          status: res.statusCode,
          responseTimeMs,
          required: check.required,
          error: passed ? null : `expected status ${check.expectedStatus}, got ${res.statusCode}`,
        });
      });
    });
    req.on('error', (err) => {
      resolve({
        name: check.name,
        path: check.path,
        passed: false,
        status: null,
        responseTimeMs: Date.now() - start,
        required: check.required,
        error: String(err.message || err),
      });
    });
    if (check.timeoutMs) {
      req.setTimeout(check.timeoutMs, () => {
        req.destroy(new Error(`timeout after ${check.timeoutMs}ms`));
      });
    }
  });
}

async function runHealthChecks(port, checks) {
  const results = [];
  for (const check of checks) {
    const r = await runHealthCheck(port, check);
    results.push(r);
  }
  return results;
}

/**
 * Run a single API journey step.
 */
function runApiStep(port, step) {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = new URL(`http://127.0.0.1:${port}${step.path}`);
    const options = {
      method: step.method || 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
    };
    let bodyData = null;
    if (step.body) {
      bodyData = step.body;
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); if (body.length > 50000) body = body.slice(-50000); });
      res.on('end', () => {
        const passed = res.statusCode === step.expectedStatus;
        resolve({
          stepName: step.name,
          passed,
          status: res.statusCode,
          durationMs: Date.now() - start,
          error: passed ? null : `expected ${step.expectedStatus}, got ${res.statusCode}`,
          response: body.slice(0, 5000),
        });
      });
    });
    req.on('error', (err) => {
      resolve({
        stepName: step.name,
        passed: false,
        status: null,
        durationMs: Date.now() - start,
        error: String(err.message || err),
        response: '',
      });
    });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runApiJourneys(port, journeys) {
  const results = [];
  for (const journey of journeys) {
    const stepsTotal = (journey.steps || []).length;
    let stepsCompleted = 0;
    let journeyPassed = true;
    for (const step of (journey.steps || [])) {
      const r = await runApiStep(port, step);
      if (r.passed) {
        stepsCompleted++;
      } else {
        journeyPassed = false;
        break;
      }
    }
    results.push({
      name: journey.name,
      passed: journeyPassed,
      stepsCompleted,
      stepsTotal,
      required: journey.required,
    });
  }
  return results;
}

/**
 * Stop the app: SIGTERM → grace → SIGKILL.
 */
function stopApp(childInfo) {
  return new Promise((resolve) => {
    const start = Date.now();
    if (!childInfo || !childInfo.child || childInfo.child.exitCode !== null || childInfo.child.signalCode) {
      resolve({ success: true, durationMs: 0 });
      return;
    }
    const child = childInfo.child;
    let exited = false;
    child.once('close', () => {
      exited = true;
      resolve({ success: true, durationMs: Date.now() - start });
    });
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (!exited) {
        try { child.kill('SIGKILL'); } catch {}
        // Wait briefly for SIGKILL to take effect.
        setTimeout(() => {
          resolve({ success: true, durationMs: Date.now() - start, forced: true });
        }, 500);
      }
    }, GRACE_MS);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = nowIso();

  // 1. Read plan.
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'));
  } catch (err) {
    const completedAt = nowIso();
    writeResults({
      installResult: null,
      buildResult: null,
      startupResult: null,
      healthChecks: [],
      apiJourneys: [],
      teardownResult: { success: true, durationMs: 0 },
      passed: false,
      failureReason: `failed to read plan.json: ${err && err.message || err}`,
      startedAt,
      completedAt,
    });
    process.exit(1);
    return;
  }

  // 2. Bring loopback up (fresh net namespace starts with lo DOWN).
  try {
    spawnSync('ip', ['link', 'set', 'lo', 'up'], { stdio: 'ignore', shell: false });
  } catch {
    // Best-effort. If ip is unavailable, the app may still bind via the
    // implicit loopback.
  }

  // Phase 18Z-A: write the source-materialization + dependency-lockfile
  // artifacts FIRST (before install runs). These record the EXACT state of
  // the repo that's about to be built. If install corrupts the repo (e.g.,
  // postinstall scripts), the manifest still records the pre-install state.
  writeSourceMaterialization();
  writeDependencyLockfile();

  // Sanitized env for install/build (NO secrets — substrate env was already
  // sanitized by runInSubstrate; we just merge in the plan-supplied env).
  const sanitizedEnv = Object.assign({}, process.env, { HOME: '/workspace' });

  // 3. Install.
  const installResult = runSyncStage(plan.install, sanitizedEnv);
  writeLogFile('install.log', '$ ' + (plan.install.binary + ' ' + (plan.install.args || []).join(' ')) + '\n' + (installResult.stdout || '') + '\n' + (installResult.stderr || '') + '\nexitCode=' + installResult.exitCode + '\n');
  if (!installResult.success) {
    const completedAt = nowIso();
    writeResults({
      installResult,
      buildResult: null,
      startupResult: null,
      healthChecks: [],
      apiJourneys: [],
      teardownResult: { success: true, durationMs: 0 },
      passed: false,
      failureReason: `install failed: ${installResult.error || `exitCode=${installResult.exitCode}`}`,
      startedAt,
      completedAt,
    });
    process.exit(1);
    return;
  }

  // 4. Build.
  const buildResult = runSyncStage(plan.build, sanitizedEnv);
  writeLogFile('build.log', '$ ' + (plan.build.binary + ' ' + (plan.build.args || []).join(' ')) + '\n' + (buildResult.stdout || '') + '\n' + (buildResult.stderr || '') + '\nexitCode=' + buildResult.exitCode + '\n');
  if (!buildResult.success) {
    const completedAt = nowIso();
    writeResults({
      installResult,
      buildResult,
      startupResult: null,
      healthChecks: [],
      apiJourneys: [],
      teardownResult: { success: true, durationMs: 0 },
      passed: false,
      failureReason: `build failed: ${buildResult.error || `exitCode=${buildResult.exitCode}`}`,
      startedAt,
      completedAt,
    });
    process.exit(1);
    return;
  }

  // 5. Start the app.
  let childInfo = null;
  let startupResult = null;
  try {
    childInfo = startApp(plan.start, sanitizedEnv);
  } catch (err) {
    const completedAt = nowIso();
    startupResult = {
      success: false,
      port: plan.port,
      pid: null,
      durationMs: 0,
      exitCode: null,
      output: String(err && err.message || err),
      error: String(err && err.message || err),
    };
    writeResults({
      installResult,
      buildResult,
      startupResult,
      healthChecks: [],
      apiJourneys: [],
      teardownResult: { success: true, durationMs: 0 },
      passed: false,
      failureReason: `failed to spawn start command: ${startupResult.error}`,
      startedAt,
      completedAt,
    });
    process.exit(1);
    return;
  }

  // 6. Wait for the port.
  const startWait = Date.now();
  const portResult = await waitForPort(plan.port, plan.startupTimeoutMs || 30000);
  if (!portResult.success) {
    // Stop the app (it may have started but not bound the port).
    await stopApp(childInfo);
    const completedAt = nowIso();
    startupResult = {
      success: false,
      port: plan.port,
      pid: childInfo.child.pid || null,
      durationMs: Date.now() - startWait,
      exitCode: childInfo.child.exitCode,
      output: (childInfo.stdout + '\n' + childInfo.stderr).slice(0, 50000),
      error: portResult.error,
    };
    writeLogFile('startup.log', 'STARTUP FAILED: ' + portResult.error + '\n' + (childInfo.stdout || '') + '\n' + (childInfo.stderr || ''));
    writeLogFile('runtime-stdout.log', childInfo.stdout || '');
    writeLogFile('runtime-stderr.log', childInfo.stderr || '');
    writeLogFile('crash-output.log', 'startup failed — app did not bind port ' + plan.port + ' within ' + (plan.startupTimeoutMs || 30000) + 'ms\n' + (childInfo.stderr || ''));
    writeResults({
      installResult,
      buildResult,
      startupResult,
      healthChecks: [],
      apiJourneys: [],
      teardownResult: { success: true, durationMs: 0 },
      passed: false,
      failureReason: `startup failed: ${portResult.error}`,
      startedAt,
      completedAt,
    });
    process.exit(1);
    return;
  }

  startupResult = {
    success: true,
    port: plan.port,
    pid: childInfo.child.pid || null,
    durationMs: portResult.durationMs,
    exitCode: null,
    output: (childInfo.stdout + '\n' + childInfo.stderr).slice(0, 50000),
  };
  writeLogFile('startup.log', 'STARTUP OK (port=' + plan.port + ', pid=' + (childInfo.child.pid || '?') + ', waited ' + portResult.durationMs + 'ms)\n' + (childInfo.stdout || '') + '\n' + (childInfo.stderr || ''));

  // 7. Run health checks.
  const healthChecks = await runHealthChecks(plan.port, plan.healthChecks || []);
  healthChecks.forEach((hc, i) => {
    writeLogFile('health-trace-' + i + '.json', JSON.stringify(hc, null, 2));
  });

  // 8. Run API journeys.
  const apiJourneys = await runApiJourneys(plan.port, plan.apiJourneys || []);
  apiJourneys.forEach((j, i) => {
    writeLogFile('api-journey-' + i + '.json', JSON.stringify(j, null, 2));
  });

  // 9. Stop the app.
  const teardownResult = await stopApp(childInfo);

  // Phase 18Z-A: write the app's full stdout/stderr (captured by the
  // orchestrator via spawn) as runtime-stdout.log + runtime-stderr.log.
  // If the app crashed (non-zero exit + stderr), also write crash-output.log.
  writeLogFile('runtime-stdout.log', childInfo.stdout || '');
  writeLogFile('runtime-stderr.log', childInfo.stderr || '');
  const appExitCode = childInfo.child.exitCode;
  const appSignal = childInfo.child.signalCode;
  if ((appExitCode !== null && appExitCode !== 0) || appSignal) {
    writeLogFile('crash-output.log', 'APP CRASHED: exitCode=' + appExitCode + ' signal=' + (appSignal || '(none)') + '\n--- stderr ---\n' + (childInfo.stderr || '') + '\n');
  }

  // 10. Determine pass/fail.
  const completedAt = nowIso();
  const requiredHealthFailed = (plan.healthChecks || []).some((hc, i) =>
    hc.required === 'required' && healthChecks[i] && !healthChecks[i].passed
  );
  const requiredJourneyFailed = (plan.apiJourneys || []).some((j, i) =>
    j.required === 'required' && apiJourneys[i] && !apiJourneys[i].passed
  );
  const passed = !requiredHealthFailed && !requiredJourneyFailed;
  let failureReason = null;
  if (requiredHealthFailed) {
    failureReason = 'required health check failed';
  } else if (requiredJourneyFailed) {
    failureReason = 'required API journey failed';
  }

  writeResults({
    installResult,
    buildResult,
    startupResult,
    healthChecks,
    apiJourneys,
    teardownResult,
    passed,
    failureReason,
    startedAt,
    completedAt,
  });

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  // Top-level catch — write a failed result and exit non-zero.
  const completedAt = nowIso();
  writeResults({
    installResult: null,
    buildResult: null,
    startupResult: null,
    healthChecks: [],
    apiJourneys: [],
    teardownResult: { success: false, durationMs: 0 },
    passed: false,
    failureReason: `orchestrator crashed: ${err && err.message || err}`,
    startedAt: completedAt,
    completedAt,
  });
  process.exit(1);
});
