// Verification module — plan, guardian, reviewer.

import { callLLM } from "../llm/gateway.js";

// --- VerificationPlan ---

export function getVerificationCommands(verificationPlan: any): {
  install: string[]; test: string[]; build: string[]; lint: string[];
} | null {
  // P12: Strict VerificationPlan — no npm fallback for missing fields.
  if (verificationPlan && typeof verificationPlan === "object" && Object.keys(verificationPlan).length > 0) {
    const install = verificationPlan.install || verificationPlan.install;
    const test = verificationPlan.unit || verificationPlan.test;
    const build = verificationPlan.build;
    const lint = verificationPlan.lint || verificationPlan.static;

    // P12: All required fields must be present. No defaults.
    if (!install || !Array.isArray(install) || install.length === 0) {
      return null; // BLOCKED — incomplete plan
    }
    if (!test || !Array.isArray(test) || test.length === 0) {
      return null; // BLOCKED — incomplete plan
    }

    return {
      install,
      test,
      build: build || [], // build is optional
      lint: lint || [], // lint is optional
    };
  }
  // P12: No plan at all — BLOCKED.
  return null;
}

// --- Deterministic Guardian ---

export function runDeterministicGuardian(architecture: any, changedFiles: { path: string; content: string }[], diff: string): {
  verdict: string; violations: any[]; warnings: any[]; summary: string;
} {
  const violations: any[] = [];
  const warnings: any[] = [];

  if (!architecture) {
    return { verdict: "WARNING", violations, warnings, summary: "No architecture contract to check against" };
  }

  const declaredTechs: string[] = (architecture.components || []).flatMap((c: any) => c.tech || []);
  const declaredTechLower = declaredTechs.map((t: string) => t.toLowerCase());

  for (const f of changedFiles) {
    const content = (f.content || "").toLowerCase();
    const path = f.path.toLowerCase();

    const forbiddenTechs: { pattern: string; tech: string }[] = [
      { pattern: "firebase", tech: "firebase" },
      { pattern: "mongoose", tech: "mongoose" },
      { pattern: "mongodb", tech: "mongodb" },
      { pattern: "supabase", tech: "supabase" },
      { pattern: "aws-sdk", tech: "aws-sdk" },
    ];

    for (const ft of forbiddenTechs) {
      if (content.includes(ft.pattern) && !declaredTechLower.some((t: string) => t.includes(ft.tech))) {
        violations.push({
          check: "forbidden-technology",
          invariant: `Technology ${ft.tech} is not in the declared architecture`,
          evidence: `File ${f.path} references ${ft.tech}`,
          files: [f.path],
          severity: "high",
          remediation: `Remove ${ft.tech} or add it to the architecture contract`,
        });
      }
    }

    if (!path.includes("test") && !path.includes("spec") && !path.includes(".test.")) {
      if (content.includes("todo") || content.includes("fixme") || content.includes("not implemented")) {
        warnings.push({
          check: "suspicious-pattern",
          invariant: "No TODO/FIXME in production code",
          evidence: `File ${f.path} contains TODO/FIXME/not-implemented marker`,
          files: [f.path],
          remediation: "Complete the implementation",
        });
      }
    }
  }

  const requiredComponents = (architecture.components || []).filter((c: any) => c.type !== "infra");
  for (const comp of requiredComponents) {
    const compFiles = changedFiles.filter((f) => {
      const path = f.path.toLowerCase();
      return path.includes(comp.name.toLowerCase()) || path.includes(comp.type.toLowerCase());
    });
    if (compFiles.length === 0) {
      warnings.push({
        check: "component-presence",
        invariant: `Component ${comp.name} should have corresponding files`,
        evidence: `No files found for component ${comp.name}`,
        files: [],
        remediation: `Ensure the implementation includes ${comp.name}`,
      });
    }
  }

  const verdict = violations.length > 0 ? "VIOLATION" : warnings.length > 0 ? "WARNING" : "PASS";
  return {
    verdict, violations, warnings,
    summary: `${violations.length} violation(s), ${warnings.length} warning(s) — ${verdict}`,
  };
}

// --- Independent LLM Reviewer ---

export async function runLlmReviewer(spec: any, changedFiles: { path: string; content: string }[], testResults: any[], guardianResult: any, apiCall: (path: string, method: string, body?: any, token?: string) => Promise<any>, executionToken: string | null): Promise<{
  verdict: string; findings: any[]; summary: string;
}> {
  const filesSummary = changedFiles.map((f) => `--- ${f.path} ---\n${(f.content || "").slice(0, 3000)}`).join("\n\n");
  const testsSummary = testResults.map((t) => `${t.name}: ${t.passes ? "PASS" : "FAIL"} (${t.evidence})`).join("\n");

  const prompt = `You are an independent code reviewer. You are NOT the implementation agent.
Review the following code changes INDEPENDENTLY. Do not trust the implementation agent's claims.

Task: ${spec.task.title}
Description: ${spec.task.description}
Acceptance criteria: ${JSON.stringify(spec.task.acceptanceCriteria)}

CHANGED FILES:
${filesSummary}

TEST RESULTS:
${testsSummary}

GUARDIAN RESULTS:
${JSON.stringify(guardianResult)}

Review for: correctness, security, edge cases, error handling, API correctness, data integrity, maintainability.
Do NOT simply approve because tests pass — tests can be incomplete.

Respond with JSON:
{ "verdict": "APPROVED" | "CHANGES_REQUESTED" | "REJECTED", "findings": [{ "severity": "low|medium|high|critical", "file": "...", "issue": "...", "recommendation": "..." }], "summary": "..." }
`;

  const result = await callLLM(spec, [
    { role: "system", content: "You are an independent code reviewer. Be skeptical and thorough." },
    { role: "user", content: prompt },
  ], apiCall, executionToken);

  if (!result.success || !result.content) {
    return {
      verdict: "CHANGES_REQUESTED",
      findings: [],
      summary: "Reviewer LLM unavailable — defaulting to CHANGES_REQUESTED for safety",
    };
  }

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict || "CHANGES_REQUESTED",
        findings: parsed.findings || [],
        summary: parsed.summary || "",
      };
    }
  } catch {}

  return {
    verdict: "CHANGES_REQUESTED",
    findings: [],
    summary: "Could not parse reviewer output",
  };
}

// --- Semantic Architecture Guardian (P12) ---
//
// Separate LLM invocation that asks: "Does this implementation remain
// faithful to the frozen architecture?"
//
// This is NOT the Reviewer. The Reviewer asks "Is this code good?"
// The Guardian asks "Does this still mean what our architecture says?"

export async function runSemanticGuardian(
  spec: any,
  changedFiles: { path: string; content: string }[],
  diff: string,
  deterministicGuardianResult: any,
  apiCall: (path: string, method: string, body?: any, token?: string) => Promise<any>,
  executionToken: string | null
): Promise<{
  verdict: string;
  findings: any[];
  summary: string;
}> {
  const filesSummary = changedFiles.map((f) => `--- ${f.path} ---\n${(f.content || "").slice(0, 2000)}`).join("\n\n");
  const archSummary = spec.architecture ? JSON.stringify({
    version: spec.architecture.version,
    hash: spec.architecture.hash,
    components: (spec.architecture.components || []).map((c: any) => ({ name: c.name, type: c.type, tech: c.tech })),
    invariants: spec.architecture.invariants,
    constraints: spec.architecture.constraints,
  }) : "No architecture contract";

  const prompt = `You are the Architecture Guardian. Your ONLY question is:
Does this implementation remain faithful to the frozen architecture?

You are NOT a code reviewer. You do not care about code quality.
You care ONLY about architectural fidelity.

FROZEN ARCHITECTURE:
${archSummary}

TASK: ${spec.task.title} (${spec.task.code})
DESCRIPTION: ${spec.task.description}

CHANGED FILES:
${filesSummary}

GIT DIFF:
${diff.slice(0, 10000)}

DETERMINISTIC GUARDIAN FINDINGS:
${JSON.stringify(deterministicGuardianResult)}

Evaluate:
- Are the declared technologies still being used?
- Are service boundaries maintained?
- Are API contracts respected?
- Are data models consistent with the architecture?
- Are there unauthorized architecture changes?
- Does the implementation introduce hidden coupling?
- Does the implementation deviate from the architectural intent?

Respond with JSON:
{
  "verdict": "PASS" | "WARNING" | "VIOLATION" | "ARCHITECTURE_CHANGE_REQUIRED",
  "findings": [{ "category": "technology|boundary|api|data_model|coupling|intent", "severity": "low|medium|high|critical", "evidence": "...", "recommendation": "..." }],
  "summary": "..."
}
`;

  const result = await callLLM(spec, [
    { role: "system", content: "You are the Architecture Guardian. You evaluate architectural fidelity, not code quality. Be strict." },
    { role: "user", content: prompt },
  ], apiCall, executionToken);

  if (!result.success || !result.content) {
    return {
      verdict: "UNVERIFIED",
      findings: [],
      summary: "Semantic Guardian LLM unavailable — UNVERIFIED (fail-closed: cannot complete without verification)",
    };
  }

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict || "UNVERIFIED",
        findings: parsed.findings || [],
        summary: parsed.summary || "",
      };
    }
  } catch {}

  return {
    verdict: "UNVERIFIED",
    findings: [],
    summary: "Could not parse semantic Guardian output — UNVERIFIED (fail-closed)",
  };
}
