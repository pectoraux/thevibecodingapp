// Verification module — plan, guardian, reviewer.

import { callLLM } from "../llm/gateway.js";

// --- VerificationPlan ---

export function getVerificationCommands(verificationPlan: any): {
  install: string[]; test: string[]; build: string[]; lint: string[];
} | null {
  if (verificationPlan && typeof verificationPlan === "object" && Object.keys(verificationPlan).length > 0) {
    return {
      install: verificationPlan.install || ["npm install"],
      test: verificationPlan.unit || verificationPlan.test || ["npm test"],
      build: verificationPlan.build || ["npm run build"],
      lint: verificationPlan.lint || verificationPlan.static || [],
    };
  }
  // P11: No silent npm fallback — return null to signal BLOCKED.
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
