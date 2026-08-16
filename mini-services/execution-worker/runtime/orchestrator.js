/*
 * Forge — Phase 18W-B: In-substrate runtime verification orchestrator.
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
 * The launcher (forge-launcher.c) observes this script's stdout/stderr and
 * signs the substrate attestation with its Ed25519 key. The attestation binds
 * the workload (this script) to the substrate facts.
 */

'use strict';

const { spawnSync, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');

const PLAN_PATH = '/workspace/plan.json';
const RESULTS_PATH = '/workspace/results.json';
const REPO_DIR = '/workspace/repo';
const GRACE_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
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

  // Sanitized env for install/build (NO secrets — substrate env was already
  // sanitized by runInSubstrate; we just merge in the plan-supplied env).
  const sanitizedEnv = Object.assign({}, process.env, { HOME: '/workspace' });

  // 3. Install.
  const installResult = runSyncStage(plan.install, sanitizedEnv);
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

  // 7. Run health checks.
  const healthChecks = await runHealthChecks(plan.port, plan.healthChecks || []);

  // 8. Run API journeys.
  const apiJourneys = await runApiJourneys(plan.port, plan.apiJourneys || []);

  // 9. Stop the app.
  const teardownResult = await stopApp(childInfo);

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
