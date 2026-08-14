// Forge — API shared helpers.
//
// Helpers for:
//   - safely JSON-parsing fields stored as JSON strings in the DB
//   - stripping secrets (apiKey on LlmProvider, value on Credential) before responding
//   - normalizing Architecture / Task / RepoFile / BuildEvent shapes for the API contract

import type {
  LlmProvider,
  Architecture,
  Task,
  RepoFile,
  RepoCommit,
  PullRequest,
  Credential,
  BuildEvent,
  ReadinessCheck,
  AgentAssignment,
} from "@prisma/client";

// ---------------------------------------------------------------------------
// parseJson — never throws, always returns fallback
// ---------------------------------------------------------------------------

export function parseJson<T>(str: string | null | undefined, fallback: T): T {
  if (str == null || str === "") return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// LlmProvider — never expose apiKey
// ---------------------------------------------------------------------------

export type LlmProviderPublic = Omit<LlmProvider, "apiKey"> & {
  capabilities: string[];
};

export function stripProvider(p: LlmProvider): LlmProviderPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKey, ...rest } = p;
  return {
    ...rest,
    capabilities: parseJson<string[]>(p.capabilities, []),
  };
}

// ---------------------------------------------------------------------------
// Architecture — pre-parse all JSON string fields
// ---------------------------------------------------------------------------

export type ArchitecturePublic = Omit<Architecture, "components" | "dataModels" | "apiContracts" | "integrations" | "invariants" | "constraints" | "testingStrategy" | "deploymentModel"> & {
  components: any[];
  dataModels: any[];
  apiContracts: any[];
  integrations: any[];
  invariants: string[];
  constraints: string[];
  testingStrategy: any;
  deploymentModel: any;
};

export function parseArchitecture(a: Architecture | null | undefined): ArchitecturePublic | null {
  if (!a) return null;
  return {
    ...a,
    components: parseJson<any[]>(a.components, []),
    dataModels: parseJson<any[]>(a.dataModels, []),
    apiContracts: parseJson<any[]>(a.apiContracts, []),
    integrations: parseJson<any[]>(a.integrations, []),
    invariants: parseJson<string[]>(a.invariants, []),
    constraints: parseJson<string[]>(a.constraints, []),
    testingStrategy: parseJson<any>(a.testingStrategy, {}),
    deploymentModel: parseJson<any>(a.deploymentModel, {}),
  };
}

// ---------------------------------------------------------------------------
// Task — pre-parse all JSON string fields
// ---------------------------------------------------------------------------

export type TaskPublic = Omit<
  Task,
  | "dependencies"
  | "inputs"
  | "outputs"
  | "acceptanceCriteria"
  | "requiredTests"
  | "filesChangedJson"
  | "testResultsJson"
  | "guardianResultJson"
  | "reviewResultJson"
> & {
  dependencies: string[];
  acceptanceCriteria: string[];
  requiredTests: string[];
  filesChanged: string[];
  testResults: any[];
  guardianResult?: any;
  reviewResult?: any;
};

export function parseTask(t: Task): TaskPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { filesChangedJson, testResultsJson, guardianResultJson, reviewResultJson, ...rest } = t;
  return {
    ...rest,
    dependencies: parseJson<string[]>(t.dependencies, []),
    acceptanceCriteria: parseJson<string[]>(t.acceptanceCriteria, []),
    requiredTests: parseJson<string[]>(t.requiredTests, []),
    filesChanged: parseJson<string[]>(filesChangedJson, []),
    testResults: parseJson<any[]>(testResultsJson, []),
    guardianResult: guardianResultJson ? parseJson<any>(guardianResultJson, null) : undefined,
    reviewResult: reviewResultJson ? parseJson<any>(reviewResultJson, null) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Credential — never expose value
// ---------------------------------------------------------------------------

export type CredentialPublic = Omit<Credential, "value">;

export function stripCredential(c: Credential): CredentialPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { value, ...rest } = c;
  return rest;
}

// ---------------------------------------------------------------------------
// RepoFile — pre-parse suspiciousPatterns
// ---------------------------------------------------------------------------

export type RepoFilePublic = Omit<RepoFile, "suspiciousPatterns"> & {
  suspiciousPatterns: string[];
};

export function parseRepoFile(f: RepoFile): RepoFilePublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { suspiciousPatterns, ...rest } = f;
  return {
    ...rest,
    suspiciousPatterns: parseJson<string[]>(suspiciousPatterns, []),
  };
}

// ---------------------------------------------------------------------------
// RepoCommit — pre-parse filesChangedJson
// ---------------------------------------------------------------------------

export type RepoCommitPublic = Omit<RepoCommit, "filesChangedJson"> & {
  filesChanged: { path: string; action: string }[];
};

export function parseRepoCommit(c: RepoCommit): RepoCommitPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { filesChangedJson, ...rest } = c;
  return {
    ...rest,
    filesChanged: parseJson<{ path: string; action: string }[]>(filesChangedJson, []),
  };
}

// ---------------------------------------------------------------------------
// PullRequest — pre-parse commitsJson + filesJson
// ---------------------------------------------------------------------------

export type PullRequestPublic = Omit<PullRequest, "commitsJson" | "filesJson"> & {
  commits: string[];
  files: string[];
};

export function parsePullRequest(p: PullRequest): PullRequestPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { commitsJson, filesJson, ...rest } = p;
  return {
    ...rest,
    commits: parseJson<string[]>(commitsJson, []),
    files: parseJson<string[]>(filesJson, []),
  };
}

// ---------------------------------------------------------------------------
// BuildEvent — pre-parse payload
// ---------------------------------------------------------------------------

export type BuildEventPublic = Omit<BuildEvent, "payload"> & {
  payload: any;
};

export function parseBuildEvent(e: BuildEvent): BuildEventPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { payload, ...rest } = e;
  return {
    ...rest,
    payload: payload ? parseJson<any>(payload, null) : null,
  };
}

// ---------------------------------------------------------------------------
// ReadinessCheck — pre-parse evidence
// ---------------------------------------------------------------------------

export type ReadinessCheckPublic = Omit<ReadinessCheck, "evidence"> & {
  evidence: any;
};

export function parseReadinessCheck(r: ReadinessCheck): ReadinessCheckPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { evidence, ...rest } = r;
  return {
    ...rest,
    evidence: evidence ? parseJson<any>(evidence, null) : null,
  };
}

// ---------------------------------------------------------------------------
// AgentAssignment — already pretty clean, just include provider
// ---------------------------------------------------------------------------

export type AgentAssignmentPublic = AgentAssignment & {
  provider?: LlmProviderPublic | null;
};

export function parseAgentAssignment(
  a: AgentAssignment & { provider?: LlmProvider | null }
): AgentAssignmentPublic {
  return {
    ...a,
    provider: a.provider ? stripProvider(a.provider) : null,
  };
}

// ---------------------------------------------------------------------------
// Read body helper — safely parse JSON body, return {} on empty/error
// ---------------------------------------------------------------------------

export async function readJsonBody(req: Request): Promise<any> {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}
