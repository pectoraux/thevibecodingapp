// Forge — Phase 18V: Substrate Attestation.
//
// OBSERVED substrate facts that prove an execution ran inside a real
// isolation boundary — not merely that a config variable said "sandbox".
// The worker OBSERVES kernel-level facts after entering the substrate and
// records them here. The control plane verifies them independently.
//
// The attestation is bound into the signed ExecutionEvidenceEnvelope (Phase
// 18F), so it is Ed25519-authenticated and execution-bound (Phase 18O).
//
// PRODUCTION GATE: executionEnvironmentSandboxed is now
// isSubstrateVerified(envelope.substrateAttestation) — replacing the Phase
// 18F hardcoded-false placeholder. No attestation => false => PRODUCTION_READY blocked.

import { createHash } from "node:crypto";

export type SubstrateType = "linux-namespace-sandbox" | "docker" | "none";

export const REQUIRED_SUBSTRATE_POLICY = {
  cpuLimitSeconds: 600,
  memoryLimitBytes: 2 * 1024 * 1024 * 1024,
  processLimit: 256,
  fileDescriptorLimit: 1024,
  fileSizeLimitBytes: 512 * 1024 * 1024,
  networkMode: "hermetic-loopback" as const,
  readonlyRootfs: true,
  blockedSyscalls: [
    "acct", "bpf", "delete_module", "finit_module", "init_module", "kcmp",
    "kexec_file_load", "kexec_load", "keyctl", "lookup_dcookie", "mount",
    "nfsservctl", "open_by_handle_at", "perf_event_open", "personality",
    "pivot_root", "ptrace", "quotactl", "reboot", "setns", "swapoff",
    "swapon", "umount2", "unshare", "vmsplice",
  ],
};

export function computeSeccompProfileHash(blockedSyscalls: string[]): string {
  const sorted = [...blockedSyscalls].sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

export const REQUIRED_SECCOMP_PROFILE_HASH = computeSeccompProfileHash(
  REQUIRED_SUBSTRATE_POLICY.blockedSyscalls
);

export const REQUIRED_DROPPED_CAPABILITIES = [
  "cap_chown","cap_dac_override","cap_dac_read_search","cap_fowner","cap_fsetid",
  "cap_kill","cap_setgid","cap_setuid","cap_setpcap","cap_linux_immutable",
  "cap_net_bind_service","cap_net_broadcast","cap_net_admin","cap_net_raw",
  "cap_ipc_lock","cap_ipc_owner","cap_sys_module","cap_sys_rawio","cap_sys_chroot",
  "cap_sys_ptrace","cap_sys_pacct","cap_sys_admin","cap_sys_boot","cap_sys_nice",
  "cap_sys_resource","cap_sys_time","cap_sys_tty_config","cap_mknod","cap_lease",
  "cap_audit_write","cap_audit_control","cap_setfcap","cap_mac_override",
  "cap_mac_admin","cap_syslog","cap_wake_alarm","cap_block_suspend",
  "cap_audit_read","cap_perfmon","cap_bpf","cap_checkpoint_restore",
];

export interface SandboxAttestation {
  substrateType: SubstrateType;
  runtimeVersion: string;
  userNamespaceInode: string | null;
  pidNamespaceInode: string | null;
  netNamespaceInode: string | null;
  mntNamespaceInode: string | null;
  seccompMode: number;
  seccompProfileHash: string;
  cpuLimitSeconds: number;
  memoryLimitBytes: number;
  processLimit: number;
  fileDescriptorLimit: number;
  fileSizeLimitBytes: number;
  capabilitiesDropped: string[];
  networkMode: "hermetic-loopback" | "bridge" | "host";
  imageDigest?: string | null;
  containerId?: string | null;
  readonlyRootfs: boolean;
  createdAt: string;
  substrateVerified: boolean;
}

export interface SubstrateVerificationResult {
  valid: boolean;
  reasons: string[];
}

const HOST_NAMESPACE_SENTINELS = new Set([
  "user:[4026531837]",
  "pid:[4026531836]",
  "net:[4026531994]",
  "mnt:[4026531840]",
]);

export function verifySubstrateAttestation(
  attestation: SandboxAttestation | null | undefined
): SubstrateVerificationResult {
  const reasons: string[] = [];
  if (!attestation) {
    return { valid: false, reasons: ["No substrate attestation provided"] };
  }
  if (attestation.substrateType === "none") {
    reasons.push("substrateType is 'none' — no physical isolation");
  } else if (
    attestation.substrateType !== "linux-namespace-sandbox" &&
    attestation.substrateType !== "docker"
  ) {
    reasons.push(`Unknown substrateType: ${attestation.substrateType}`);
  }
  if (!attestation.substrateVerified) {
    reasons.push("Worker self-check substrateVerified is false");
  }
  const nsFields: Array<[string, string | null]> = [
    ["userNamespaceInode", attestation.userNamespaceInode],
    ["pidNamespaceInode", attestation.pidNamespaceInode],
    ["netNamespaceInode", attestation.netNamespaceInode],
    ["mntNamespaceInode", attestation.mntNamespaceInode],
  ];
  for (const [name, inode] of nsFields) {
    if (!inode) {
      reasons.push(`${name} is missing`);
    } else if (HOST_NAMESPACE_SENTINELS.has(inode)) {
      reasons.push(`${name} (${inode}) matches a host sentinel — NOT in a new namespace`);
    }
  }
  if (attestation.seccompMode !== 2) {
    reasons.push(`seccompMode is ${attestation.seccompMode} (required: 2)`);
  }
  if (attestation.seccompProfileHash !== REQUIRED_SECCOMP_PROFILE_HASH) {
    reasons.push("seccompProfileHash does not match the required filter");
  }
  if (!Number.isFinite(attestation.cpuLimitSeconds)) reasons.push("cpuLimitSeconds unlimited");
  if (!Number.isFinite(attestation.memoryLimitBytes)) reasons.push("memoryLimitBytes unlimited");
  if (!Number.isFinite(attestation.processLimit)) reasons.push("processLimit unlimited");
  if (!Number.isFinite(attestation.fileDescriptorLimit)) reasons.push("fileDescriptorLimit unlimited");
  if (!Number.isFinite(attestation.fileSizeLimitBytes)) reasons.push("fileSizeLimitBytes unlimited");
  const dropped = new Set(attestation.capabilitiesDropped);
  const missing = REQUIRED_DROPPED_CAPABILITIES.filter((c) => !dropped.has(c));
  if (missing.length > 0) {
    reasons.push(`capabilitiesDropped missing ${missing.length} required caps (e.g. ${missing.slice(0, 3).join(", ")})`);
  }
  if (attestation.networkMode !== "hermetic-loopback") {
    reasons.push(`networkMode is ${attestation.networkMode} (required: hermetic-loopback)`);
  }
  if (!attestation.readonlyRootfs) {
    reasons.push("readonlyRootfs is false");
  }
  if (attestation.substrateType === "docker") {
    if (!attestation.imageDigest) reasons.push("docker substrate missing imageDigest");
    if (!attestation.containerId) reasons.push("docker substrate missing containerId");
  }
  return { valid: reasons.length === 0, reasons };
}

export function isSubstrateVerified(
  attestation: SandboxAttestation | null | undefined
): boolean {
  return verifySubstrateAttestation(attestation).valid;
}

function canonicalString(value: any): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalString).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalString(value[k])).join(",") + "}";
  }
  return "null";
}

export function computeAttestationHash(attestation: SandboxAttestation): string {
  const fields = {
    capabilitiesDropped: [...attestation.capabilitiesDropped].sort(),
    containerId: attestation.containerId ?? null,
    cpuLimitSeconds: attestation.cpuLimitSeconds,
    createdAt: attestation.createdAt,
    fileSizeLimitBytes: attestation.fileSizeLimitBytes,
    fileDescriptorLimit: attestation.fileDescriptorLimit,
    imageDigest: attestation.imageDigest ?? null,
    memoryLimitBytes: attestation.memoryLimitBytes,
    mntNamespaceInode: attestation.mntNamespaceInode,
    netNamespaceInode: attestation.netNamespaceInode,
    networkMode: attestation.networkMode,
    pidNamespaceInode: attestation.pidNamespaceInode,
    processLimit: attestation.processLimit,
    readonlyRootfs: attestation.readonlyRootfs,
    runtimeVersion: attestation.runtimeVersion,
    seccompMode: attestation.seccompMode,
    seccompProfileHash: attestation.seccompProfileHash,
    substrateType: attestation.substrateType,
    substrateVerified: attestation.substrateVerified,
    userNamespaceInode: attestation.userNamespaceInode,
  };
  return createHash("sha256").update(canonicalString(fields)).digest("hex");
}
