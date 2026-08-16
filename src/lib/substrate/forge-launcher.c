/*
 * Forge — Phase 18W: substrate launcher (forge-launcher.c)
 *
 * TWO-SIGNATURE TRUST MODEL. The launcher gets its OWN Ed25519 key (separate
 * from the worker key, provisioned by admin). The launcher signs the observed
 * facts + nonce + executionId + workload results. The worker includes the
 * launcher-signed attestation in its envelope. The control plane verifies
 * BOTH signatures. A compromised worker cannot manufacture a valid substrate
 * claim — it does not have the launcher private key.
 *
 * Invoked as:
 *   forge-launcher <launcher_key_file> <nonce> <execution_id>
 *                  <substrate_instance_id> <facts_file> <rootfs_dir>
 *                  <workspace_dir> <binary> [args...]
 *
 * Runs INSIDE `unshare -U -r -p -f -n -m --propagation=private`, so by the
 * time main() is entered we are already inside fresh user/pid/net/mnt
 * namespaces. The inodes we readlink here are the NEW namespace inodes.
 *
 * Flow:
 *   1. Read launcher Ed25519 private key from file (BEFORE chroot — the key
 *      file lives on the host filesystem).
 *   2. setrlimit for RLIMIT_CPU (600), RLIMIT_AS (2GiB), RLIMIT_NPROC (256),
 *      RLIMIT_NOFILE (1024), RLIMIT_FSIZE (512MiB). Fail-closed for CPU/AS;
 *      for NPROC/NOFILE/FSIZE, clamp-to-hard if already lower.
 *   3. readlink /proc/self/ns/{user,pid,net,mnt} — observed new-namespace
 *      inodes. ALSO: open /proc/self/status fd + facts-file fd (before chroot).
 *   4. prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0).
 *   5. Bind-mount system dirs + dev nodes + workspace (+ optionally /proc)
 *      into rootfs. The rootfs dir + subdirs + empty dev files were created
 *      by the TypeScript side (buildRootfs) before unshare was spawned.
 *   6. chroot(rootfs_dir); chdir("/"). Fail-closed (exit 3).
 *   7. Install seccomp BPF filter blocking the 25 syscalls. Fail-closed (exit 4).
 *   8. lseek+read the /proc/self/status fd; parse "Seccomp:" and "CapEff:".
 *   9. getrlimit for the 5 limits (observed soft values).
 *  10. Create pipes for stdout/stderr capture.
 *  11. Fork. Child: dup2 stdout/stderr to pipes, execvp workload.
 *      Parent: poll both pipes, forward bytes to own stdout/stderr, compute
 *      SHA-256 of each stream (OpenSSL EVP_DigestInit_ex/EVP_DigestUpdate).
 *  12. waitpid. Extract workloadExitCode / workloadSignal.
 *  13. Build canonicalFactsJson (sorted keys, no whitespace) containing:
 *      substrateFacts (nested), nonce, executionId, substrateInstanceId,
 *      workloadExitCode, workloadSignal, workloadStdoutHash, workloadStderrHash,
 *      signedAt.
 *  14. Sign canonicalFactsJson UTF-8 bytes with Ed25519 (EVP_DigestSign).
 *  15. Write facts file JSON: { ...all substrate facts..., nonce, executionId,
 *      substrateInstanceId, workloadExitCode, workloadSignal, workloadStdoutHash,
 *      workloadStderrHash, canonicalFactsJson, launcherSignature (hex),
 *      launcherAlgorithm: "ed25519", launcherKeyId: "forge-launcher-v2",
 *      launcherSignedAt }.
 *  16. Exit with the workload's exit code (or 128+signal if killed by signal).
 *
 * Fail-closed: missing key, signing failure, write failure, or any setup
 * failure → launcher exits non-zero with NO facts file produced (or an empty
 * one). The TypeScript wrapper treats a missing/empty facts file as "substrate
 * could not be established" and refuses to fabricate an attestation.
 *
 * SIGNING HAPPENS INSIDE THE SUBSTRATE (after chroot+seccomp). The launcher
 * private key is read BEFORE chroot (from the host filesystem) but the
 * signing operation happens AFTER chroot+seccomp, so the signature
 * cryptographically attests to the post-seccomp kernel state.
 *
 * Environment:
 *   SUBSTRATE_INCLUDE_PROC=1  → bind-mount /proc into rootfs/proc (RO).
 *
 * Compile: gcc -O2 -o forge-launcher forge-launcher.c -lcrypto
 */

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <time.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <linux/bpf_common.h>
#include <stddef.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/err.h>
#include <openssl/sha.h>

/* x86_64 architecture identifier for the seccomp_data.arch field. */
#define ARCH_NR AUDIT_ARCH_X86_64

/* Resource limits — match REQUIRED_SUBSTRATE_POLICY. */
#define CPU_LIMIT_SECONDS 600
#define MEMORY_LIMIT_BYTES (2LL * 1024LL * 1024LL * 1024LL)
#define PROCESS_LIMIT 256
#define FD_LIMIT 1024
#define FILE_SIZE_LIMIT_BYTES (512LL * 1024LL * 1024LL)

#define RUNTIME_VERSION "forge-namespace-launcher-v2"
#define LAUNCHER_KEY_ID "forge-launcher-v2"
#define LAUNCHER_ALGORITHM "ed25519"

/* Blocked syscalls — match REQUIRED_SUBSTRATE_POLICY.blockedSyscalls (sorted). */
struct sc_filter {
  const char *name;
  int nr;
};

static const struct sc_filter blocked_syscalls[] = {
  { "acct",              SYS_acct              },
  { "bpf",               SYS_bpf               },
  { "delete_module",     SYS_delete_module     },
  { "finit_module",      SYS_finit_module      },
  { "init_module",       SYS_init_module       },
  { "kcmp",              SYS_kcmp              },
  { "kexec_file_load",   SYS_kexec_file_load   },
  { "kexec_load",        SYS_kexec_load        },
  { "keyctl",            SYS_keyctl            },
  { "lookup_dcookie",    SYS_lookup_dcookie    },
  { "mount",             SYS_mount             },
  { "nfsservctl",        SYS_nfsservctl        },
  { "open_by_handle_at", SYS_open_by_handle_at },
  { "perf_event_open",   SYS_perf_event_open   },
  { "personality",       SYS_personality       },
  { "pivot_root",        SYS_pivot_root        },
  { "ptrace",            SYS_ptrace            },
  { "quotactl",          SYS_quotactl          },
  { "reboot",            SYS_reboot            },
  { "setns",             SYS_setns             },
  { "swapoff",           SYS_swapoff           },
  { "swapon",            SYS_swapon            },
  { "umount2",           SYS_umount2           },
  { "unshare",           SYS_unshare           },
  { "vmsplice",          SYS_vmsplice          },
};
static const size_t NUM_BLOCKED =
    sizeof(blocked_syscalls) / sizeof(blocked_syscalls[0]);

/* Buffer sizes. */
#define INODE_BUF_LEN 64
#define STATUS_BUF_LEN 8192
#define PATH_BUF_LEN 4096
#define READ_BUF_LEN 4096
#define SIG_HEX_LEN 129   /* 64 bytes * 2 + NUL */
#define HASH_HEX_LEN 65   /* 32 bytes * 2 + NUL */

/* Bind-mount specification. */
struct bind_spec {
  const char *src;
  const char *dst_rel;
  int required;
};

static const struct bind_spec system_binds[] = {
  { "/bin",  "bin",  1 },
  { "/sbin", "sbin", 0 },
  { "/lib",  "lib",  1 },
  { "/usr",  "usr",  1 },
  { "/lib64", "lib64", 0 },
};

static const struct bind_spec dev_binds[] = {
  { "/dev/null",    "dev/null",    1 },
  { "/dev/zero",    "dev/zero",    1 },
  { "/dev/urandom", "dev/urandom", 1 },
};

/* ----------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ----------------------------------------------------------------------- */

static int read_ns_inode(const char *path, char *out, size_t out_len) {
  char buf[INODE_BUF_LEN];
  ssize_t n = readlink(path, buf, sizeof(buf) - 1);
  if (n < 0) return -1;
  buf[n] = '\0';
  if ((size_t)n >= out_len) n = out_len - 1;
  memcpy(out, buf, (size_t)n);
  out[n] = '\0';
  return 0;
}

static int apply_rlimit(int resource, rlim_t soft, rlim_t hard, int fail_closed) {
  struct rlimit cur;
  if (getrlimit(resource, &cur) != 0) {
    if (fail_closed) return -1;
    return 0;
  }
  struct rlimit new_lim;
  new_lim.rlim_cur = soft;
  new_lim.rlim_max = hard;
  if (cur.rlim_max < hard) {
    new_lim.rlim_max = cur.rlim_max;
    if (new_lim.rlim_cur > cur.rlim_max) new_lim.rlim_cur = cur.rlim_max;
  }
  if (setrlimit(resource, &new_lim) != 0) {
    if (fail_closed) return -1;
    new_lim.rlim_cur = cur.rlim_max;
    new_lim.rlim_max = cur.rlim_max;
    if (setrlimit(resource, &new_lim) != 0) {
      return 0;
    }
  }
  return 0;
}

static int install_seccomp_filter(void) {
  const size_t n = NUM_BLOCKED;
  const size_t total_insns = 1 + n + 2;
  struct sock_filter *prog =
      (struct sock_filter *)calloc(total_insns, sizeof(struct sock_filter));
  if (!prog) return -1;

  size_t idx = 0;
  prog[idx++] = (struct sock_filter)BPF_STMT(
      BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  for (size_t i = 0; i < n; i++) {
    prog[idx++] = (struct sock_filter)BPF_JUMP(
        BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)blocked_syscalls[i].nr,
        (unsigned char)(n - i), 0);
  }
  prog[idx++] = (struct sock_filter)BPF_STMT(
      BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  prog[idx++] = (struct sock_filter)BPF_STMT(
      BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);

  if (idx != total_insns) {
    free(prog);
    return -1;
  }

  struct sock_fprog fprog = {
      .len = (unsigned short)total_insns,
      .filter = prog,
  };

  int rc = (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &fprog);
  free(prog);
  return rc;
}

static int parse_proc_status(int fd, int *seccomp_mode, char *cap_eff,
                             size_t cap_eff_len) {
  char buf[STATUS_BUF_LEN];
  if (lseek(fd, 0, SEEK_SET) == (off_t)-1) return -1;
  ssize_t n = read(fd, buf, sizeof(buf) - 1);
  if (n <= 0) return -1;
  buf[n] = '\0';

  *seccomp_mode = -1;
  cap_eff[0] = '\0';

  char *p = buf;
  while (*p) {
    char *nl = strchr(p, '\n');
    if (!nl) nl = p + strlen(p);
    if (strncmp(p, "Seccomp:", 8) == 0) {
      char *v = p + 8;
      while (v < nl && (*v == '\t' || *v == ' ')) v++;
      *seccomp_mode = atoi(v);
    } else if (strncmp(p, "CapEff:", 7) == 0) {
      char *v = p + 7;
      while (v < nl && (*v == '\t' || *v == ' ')) v++;
      size_t len = (size_t)(nl - v);
      if (len >= cap_eff_len) len = cap_eff_len - 1;
      memcpy(cap_eff, v, len);
      cap_eff[len] = '\0';
    }
    if (*nl == '\0') break;
    p = nl + 1;
  }
  return 0;
}

static void format_iso_utc(char *out, size_t out_len) {
  time_t now = time(NULL);
  struct tm tm_utc;
  gmtime_r(&now, &tm_utc);
  strftime(out, out_len, "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
}

static int do_bind(const char *rootfs_dir, const char *src, const char *dst_rel,
                   int required) {
  char dst[PATH_BUF_LEN];
  int n = snprintf(dst, sizeof(dst), "%s/%s", rootfs_dir, dst_rel);
  if (n < 0 || (size_t)n >= sizeof(dst)) {
    fprintf(stderr, "forge-launcher: path too long: %s/%s\n", rootfs_dir, dst_rel);
    return required ? -1 : 1;
  }
  struct stat st;
  if (stat(src, &st) != 0) {
    if (!required) return 1;
    fprintf(stderr, "forge-launcher: bind source missing: %s\n", src);
    return -1;
  }
  if (stat(dst, &st) != 0) {
    if (!required) return 1;
    fprintf(stderr, "forge-launcher: bind destination missing: %s\n", dst);
    return -1;
  }
  if (mount(src, dst, NULL, MS_BIND, NULL) != 0) {
    fprintf(stderr, "forge-launcher: mount --bind %s %s: %s\n", src, dst,
            strerror(errno));
    return -1;
  }
  return 0;
}

static int run_bind(const char *rootfs_dir, const char *src, const char *dst_rel,
                    int required) {
  int rc = do_bind(rootfs_dir, src, dst_rel, required);
  if (rc == -1 && required) return -1;
  return 0;
}

static void maybe_bind_proc(const char *rootfs_dir) {
  const char *v = getenv("SUBSTRATE_INCLUDE_PROC");
  if (!v || v[0] != '1') return;
  char dst[PATH_BUF_LEN];
  int n = snprintf(dst, sizeof(dst), "%s/proc", rootfs_dir);
  if (n < 0 || (size_t)n >= sizeof(dst)) return;
  if (mount("/proc", dst, NULL, MS_BIND, NULL) != 0) {
    fprintf(stderr,
            "forge-launcher: warning — /proc bind failed (%s); continuing without /proc\n",
            strerror(errno));
    return;
  }
  if (mount(NULL, dst, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL) != 0) {
    /* Non-fatal. */
  }
}

/* write_all — write exactly len bytes, retrying on partial writes / EINTR. */
static ssize_t write_all(int fd, const void *buf, size_t len) {
  size_t total = 0;
  const char *p = (const char *)buf;
  while (total < len) {
    ssize_t n = write(fd, p + total, len - total);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (n == 0) break;
    total += (size_t)n;
  }
  return (ssize_t)total;
}

/* to_hex — convert binary to lowercase hex string. out must be 2*len+1. */
static void to_hex(const unsigned char *in, size_t len, char *out) {
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < len; i++) {
    out[2 * i]     = hex[(in[i] >> 4) & 0xf];
    out[2 * i + 1] = hex[in[i] & 0xf];
  }
  out[2 * len] = '\0';
}

/* json_escape — write a JSON-escaped string (with surrounding quotes) to f. */
static void json_escape(FILE *f, const char *s) {
  fputc('"', f);
  for (const char *p = s; *p; p++) {
    unsigned char c = (unsigned char)*p;
    if (c == '"') { fputs("\\\"", f); }
    else if (c == '\\') { fputs("\\\\", f); }
    else if (c == '\n') { fputs("\\n", f); }
    else if (c == '\r') { fputs("\\r", f); }
    else if (c == '\t') { fputs("\\t", f); }
    else if (c < 0x20) { fprintf(f, "\\u%04x", c); }
    else { fputc((int)c, f); }
  }
  fputc('"', f);
}

/* ----------------------------------------------------------------------- */
/* Launcher key — read Ed25519 private key from PEM file (BEFORE chroot)    */
/* ----------------------------------------------------------------------- */

static EVP_PKEY *read_launcher_key(const char *key_file) {
  if (!key_file || !key_file[0]) {
    fprintf(stderr, "forge-launcher: launcher_key_file is empty\n");
    return NULL;
  }
  BIO *bio = BIO_new_file(key_file, "r");
  if (!bio) {
    fprintf(stderr, "forge-launcher: cannot open launcher key file %s: %s\n",
            key_file, strerror(errno));
    return NULL;
  }
  EVP_PKEY *pkey = PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
  BIO_free(bio);
  if (!pkey) {
    fprintf(stderr,
            "forge-launcher: failed to parse launcher private key from %s "
            "(not a valid PEM Ed25519 private key)\n",
            key_file);
    ERR_print_errors_fp(stderr);
    return NULL;
  }
  if (EVP_PKEY_id(pkey) != EVP_PKEY_ED25519) {
    fprintf(stderr,
            "forge-launcher: launcher key is not Ed25519 (got type %d)\n",
            EVP_PKEY_id(pkey));
    EVP_PKEY_free(pkey);
    return NULL;
  }
  return pkey;
}

/* ----------------------------------------------------------------------- */
/* SHA-256 streaming — compute hash of a pipe's content while forwarding    */
/* ----------------------------------------------------------------------- */

typedef struct {
  EVP_MD_CTX *ctx;
  unsigned char digest[32];
  unsigned int digest_len;
  char hex[HASH_HEX_LEN];
  int finalized;
} sha256_stream;

static int sha_stream_init(sha256_stream *s) {
  s->ctx = EVP_MD_CTX_new();
  if (!s->ctx) return -1;
  if (EVP_DigestInit_ex(s->ctx, EVP_sha256(), NULL) != 1) {
    EVP_MD_CTX_free(s->ctx);
    s->ctx = NULL;
    return -1;
  }
  s->finalized = 0;
  s->digest_len = 0;
  s->hex[0] = '\0';
  return 0;
}

static int sha_stream_update(sha256_stream *s, const void *data, size_t len) {
  if (!s->ctx || s->finalized) return -1;
  return EVP_DigestUpdate(s->ctx, data, len) == 1 ? 0 : -1;
}

static int sha_stream_final(sha256_stream *s) {
  if (!s->ctx || s->finalized) return -1;
  if (EVP_DigestFinal_ex(s->ctx, s->digest, &s->digest_len) != 1) return -1;
  EVP_MD_CTX_free(s->ctx);
  s->ctx = NULL;
  s->finalized = 1;
  to_hex(s->digest, s->digest_len, s->hex);
  return 0;
}

/* ----------------------------------------------------------------------- */
/* canonicalFactsJson — sorted keys, no whitespace                          */
/* ----------------------------------------------------------------------- */

/* Build the canonical JSON string. Returns malloc'd buffer (caller frees).
 * Sets *out_len to the byte length (excluding NUL). */
static char *build_canonical_facts(
    const char *user_ns, const char *pid_ns, const char *net_ns,
    const char *mnt_ns, int seccomp_mode, const char *cap_eff,
    rlim_t cpu_soft, rlim_t as_soft, rlim_t nproc_soft, rlim_t nofile_soft,
    rlim_t fsize_soft, const char *nonce, const char *execution_id,
    const char *substrate_instance_id, int workload_exit_code,
    int workload_signal, const char *stdout_hash, const char *stderr_hash,
    const char *signed_at, size_t *out_len) {

  char *buf = NULL;
  size_t buf_len = 0;
  FILE *mem = open_memstream(&buf, &buf_len);
  if (!mem) return NULL;

  /* Top-level keys sorted alphabetically: executionId, nonce, signedAt,
   * substrateFacts, substrateInstanceId, workloadExitCode, workloadSignal,
   * workloadStderrHash, workloadStdoutHash. */
  fprintf(mem, "{");
  fprintf(mem, "\"executionId\":");
  json_escape(mem, execution_id);
  fprintf(mem, ",\"nonce\":");
  json_escape(mem, nonce);
  fprintf(mem, ",\"signedAt\":");
  json_escape(mem, signed_at);
  fprintf(mem, ",\"substrateFacts\":{");
  /* Substrate facts keys sorted: blockedSyscalls, capEffHex, cpuLimitSeconds,
   * fileDescriptorLimit, fileSizeLimitBytes, memoryLimitBytes,
   * mntNamespaceInode, netNamespaceInode, networkMode, pidNamespaceInode,
   * processLimit, runtimeVersion, seccompMode, userNamespaceInode. */
  fprintf(mem, "\"blockedSyscalls\":[");
  for (size_t i = 0; i < NUM_BLOCKED; i++) {
    fprintf(mem, "\"%s\"%s", blocked_syscalls[i].name,
            (i + 1 < NUM_BLOCKED) ? "," : "");
  }
  fprintf(mem, "],");
  fprintf(mem, "\"capEffHex\":");
  json_escape(mem, cap_eff);
  fprintf(mem, ",\"cpuLimitSeconds\":%llu,", (unsigned long long)cpu_soft);
  fprintf(mem, "\"fileDescriptorLimit\":%llu,", (unsigned long long)nofile_soft);
  fprintf(mem, "\"fileSizeLimitBytes\":%llu,", (unsigned long long)fsize_soft);
  fprintf(mem, "\"memoryLimitBytes\":%llu,", (unsigned long long)as_soft);
  fprintf(mem, "\"mntNamespaceInode\":");
  json_escape(mem, mnt_ns);
  fprintf(mem, ",\"netNamespaceInode\":");
  json_escape(mem, net_ns);
  fprintf(mem, ",\"networkMode\":\"hermetic-loopback\",");
  fprintf(mem, "\"pidNamespaceInode\":");
  json_escape(mem, pid_ns);
  fprintf(mem, ",\"processLimit\":%llu,", (unsigned long long)nproc_soft);
  fprintf(mem, "\"runtimeVersion\":\"%s\",", RUNTIME_VERSION);
  fprintf(mem, "\"seccompMode\":%d,", seccomp_mode);
  fprintf(mem, "\"userNamespaceInode\":");
  json_escape(mem, user_ns);
  fprintf(mem, "}");
  fprintf(mem, ",\"substrateInstanceId\":");
  json_escape(mem, substrate_instance_id);
  fprintf(mem, ",\"workloadExitCode\":");
  if (workload_exit_code < 0) fprintf(mem, "null");
  else fprintf(mem, "%d", workload_exit_code);
  fprintf(mem, ",\"workloadSignal\":");
  if (workload_signal <= 0) fprintf(mem, "null");
  else fprintf(mem, "%d", workload_signal);
  fprintf(mem, ",\"workloadStderrHash\":");
  json_escape(mem, stderr_hash);
  fprintf(mem, ",\"workloadStdoutHash\":");
  json_escape(mem, stdout_hash);
  fprintf(mem, "}");

  fclose(mem);
  *out_len = buf_len;
  return buf;
}

/* ----------------------------------------------------------------------- */
/* Ed25519 sign — sign canonicalFactsJson bytes                             */
/* ----------------------------------------------------------------------- */

static int sign_canonical(EVP_PKEY *launcher_key, const char *canonical,
                          size_t canon_len, char *sig_hex_out) {
  EVP_MD_CTX *md = EVP_MD_CTX_new();
  if (!md) return -1;

  size_t sig_len = 0;
  if (EVP_DigestSignInit(md, NULL, NULL, NULL, launcher_key) != 1) {
    EVP_MD_CTX_free(md);
    return -1;
  }
  if (EVP_DigestSign(md, NULL, &sig_len, (const unsigned char *)canonical,
                     canon_len) != 1) {
    EVP_MD_CTX_free(md);
    return -1;
  }
  unsigned char *sig = (unsigned char *)malloc(sig_len);
  if (!sig) {
    EVP_MD_CTX_free(md);
    return -1;
  }
  if (EVP_DigestSign(md, sig, &sig_len, (const unsigned char *)canonical,
                     canon_len) != 1) {
    free(sig);
    EVP_MD_CTX_free(md);
    return -1;
  }
  EVP_MD_CTX_free(md);
  to_hex(sig, sig_len, sig_hex_out);
  free(sig);
  return 0;
}

/* ----------------------------------------------------------------------- */
/* write_facts_json — write the full facts file with all fields             */
/* ----------------------------------------------------------------------- */

static int write_facts_json(
    int fd, const char *user_ns, const char *pid_ns, const char *net_ns,
    const char *mnt_ns, int seccomp_mode, const char *cap_eff,
    rlim_t cpu_soft, rlim_t as_soft, rlim_t nproc_soft, rlim_t nofile_soft,
    rlim_t fsize_soft, const char *created_at, const char *nonce,
    const char *execution_id, const char *substrate_instance_id,
    int workload_exit_code, int workload_signal, const char *stdout_hash,
    const char *stderr_hash, const char *canonical, const char *sig_hex,
    const char *signed_at) {

  if (ftruncate(fd, 0) != 0) return -1;
  if (lseek(fd, 0, SEEK_SET) == (off_t)-1) return -1;

  FILE *f = fdopen(dup(fd), "w");
  if (!f) return -1;

  /* Emit JSON. Keys in a stable order (not strictly required for the outer
   * object — only canonicalFactsJson must be canonical). */
  int rc = 0;
  rc |= fprintf(f, "{");
  rc |= fprintf(f, "\"runtimeVersion\":\"%s\",", RUNTIME_VERSION);
  rc |= fprintf(f, "\"userNamespaceInode\":"); json_escape(f, user_ns); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"pidNamespaceInode\":"); json_escape(f, pid_ns); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"netNamespaceInode\":"); json_escape(f, net_ns); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"mntNamespaceInode\":"); json_escape(f, mnt_ns); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"seccompMode\":%d,", seccomp_mode);
  rc |= fprintf(f, "\"capEffHex\":"); json_escape(f, cap_eff); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"blockedSyscalls\":[");
  for (size_t i = 0; i < NUM_BLOCKED; i++) {
    rc |= fprintf(f, "\"%s\"%s", blocked_syscalls[i].name,
                  (i + 1 < NUM_BLOCKED) ? "," : "");
  }
  rc |= fprintf(f, "],");
  rc |= fprintf(f, "\"cpuLimitSeconds\":%llu,", (unsigned long long)cpu_soft);
  rc |= fprintf(f, "\"memoryLimitBytes\":%llu,", (unsigned long long)as_soft);
  rc |= fprintf(f, "\"processLimit\":%llu,", (unsigned long long)nproc_soft);
  rc |= fprintf(f, "\"fileDescriptorLimit\":%llu,", (unsigned long long)nofile_soft);
  rc |= fprintf(f, "\"fileSizeLimitBytes\":%llu,", (unsigned long long)fsize_soft);
  rc |= fprintf(f, "\"createdAt\":"); json_escape(f, created_at); rc |= fprintf(f, ",");
  /* Phase 18W new fields. */
  rc |= fprintf(f, "\"nonce\":"); json_escape(f, nonce); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"executionId\":"); json_escape(f, execution_id); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"substrateInstanceId\":"); json_escape(f, substrate_instance_id); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"workloadExitCode\":");
  if (workload_exit_code < 0) rc |= fprintf(f, "null,");
  else rc |= fprintf(f, "%d,", workload_exit_code);
  rc |= fprintf(f, "\"workloadSignal\":");
  if (workload_signal <= 0) rc |= fprintf(f, "null,");
  else rc |= fprintf(f, "%d,", workload_signal);
  rc |= fprintf(f, "\"workloadStdoutHash\":"); json_escape(f, stdout_hash); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"workloadStderrHash\":"); json_escape(f, stderr_hash); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"canonicalFactsJson\":"); json_escape(f, canonical); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"launcherSignature\":"); json_escape(f, sig_hex); rc |= fprintf(f, ",");
  rc |= fprintf(f, "\"launcherAlgorithm\":\"%s\",", LAUNCHER_ALGORITHM);
  rc |= fprintf(f, "\"launcherKeyId\":\"%s\",", LAUNCHER_KEY_ID);
  rc |= fprintf(f, "\"launcherSignedAt\":"); json_escape(f, signed_at);
  rc |= fprintf(f, "}\n");

  fflush(f);
  fsync(fileno(f));
  fclose(f);

  return rc < 0 ? -1 : 0;
}

/* ----------------------------------------------------------------------- */
/* main                                                                     */
/* ----------------------------------------------------------------------- */

int main(int argc, char **argv) {
  /* Ignore SIGPIPE — if the parent (TS) closes its read end, we still need
   * to finish computing hashes and writing the facts file. */
  signal(SIGPIPE, SIG_IGN);

  if (argc < 9) {
    fprintf(stderr,
            "forge-launcher: usage: %s <launcher_key_file> <nonce> <execution_id> "
            "<substrate_instance_id> <facts_file> <rootfs_dir> <workspace_dir> "
            "<binary> [args...]\n",
            argv[0]);
    return 2;
  }

  const char *launcher_key_file = argv[1];
  const char *nonce = argv[2];
  const char *execution_id = argv[3];
  const char *substrate_instance_id = argv[4];
  const char *facts_path = argv[5];
  const char *rootfs_dir = argv[6];
  const char *workspace_dir = argv[7];
  /* argv[8] = binary; argv[9..] = args. */

  /* ------------------------------------------------------------- *
   * STEP 1: read launcher Ed25519 private key (BEFORE chroot)
   * ------------------------------------------------------------- */
  EVP_PKEY *launcher_key = read_launcher_key(launcher_key_file);
  if (!launcher_key) {
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 2: setrlimit
   * ------------------------------------------------------------- */
  if (apply_rlimit(RLIMIT_CPU, CPU_LIMIT_SECONDS, CPU_LIMIT_SECONDS, 1) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_CPU)");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (apply_rlimit(RLIMIT_AS, MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES, 1) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_AS)");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (apply_rlimit(RLIMIT_NPROC, PROCESS_LIMIT, PROCESS_LIMIT, 0) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_NPROC)");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (apply_rlimit(RLIMIT_NOFILE, FD_LIMIT, FD_LIMIT, 0) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_NOFILE)");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (apply_rlimit(RLIMIT_FSIZE, FILE_SIZE_LIMIT_BYTES, FILE_SIZE_LIMIT_BYTES,
                   0) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_FSIZE)");
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 3: read namespace inodes + open /proc/self/status fd +
   *         open facts-file fd (all BEFORE chroot)
   * ------------------------------------------------------------- */
  char user_ns[INODE_BUF_LEN];
  char pid_ns[INODE_BUF_LEN];
  char net_ns[INODE_BUF_LEN];
  char mnt_ns[INODE_BUF_LEN];

  if (read_ns_inode("/proc/self/ns/user", user_ns, sizeof(user_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/user");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (read_ns_inode("/proc/self/ns/pid", pid_ns, sizeof(pid_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/pid");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (read_ns_inode("/proc/self/ns/net", net_ns, sizeof(net_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/net");
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  if (read_ns_inode("/proc/self/ns/mnt", mnt_ns, sizeof(mnt_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/mnt");
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  int status_fd = open("/proc/self/status", O_RDONLY | O_CLOEXEC);
  if (status_fd < 0) {
    perror("forge-launcher: open /proc/self/status");
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  int facts_fd =
      open(facts_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (facts_fd < 0) {
    perror("forge-launcher: open facts_file");
    close(status_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 4: PR_SET_NO_NEW_PRIVS
   * ------------------------------------------------------------- */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("forge-launcher: prctl(PR_SET_NO_NEW_PRIVS)");
    close(status_fd);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 5: bind-mounts (inside the user namespace)
   * ------------------------------------------------------------- */
  for (size_t i = 0; i < sizeof(system_binds) / sizeof(system_binds[0]); i++) {
    if (run_bind(rootfs_dir, system_binds[i].src, system_binds[i].dst_rel,
                 system_binds[i].required) != 0) {
      close(status_fd);
      close(facts_fd);
      EVP_PKEY_free(launcher_key);
      return 1;
    }
  }
  for (size_t i = 0; i < sizeof(dev_binds) / sizeof(dev_binds[0]); i++) {
    if (run_bind(rootfs_dir, dev_binds[i].src, dev_binds[i].dst_rel,
                 dev_binds[i].required) != 0) {
      close(status_fd);
      close(facts_fd);
      EVP_PKEY_free(launcher_key);
      return 1;
    }
  }
  int ws_rc = do_bind(rootfs_dir, workspace_dir, "workspace", 0);
  if (ws_rc == -1) {
    fprintf(stderr,
            "forge-launcher: warning — workspace bind failed; continuing with empty /workspace\n");
  }
  maybe_bind_proc(rootfs_dir);

  /* ------------------------------------------------------------- *
   * STEP 6: chroot + chdir
   * ------------------------------------------------------------- */
  if (chroot(rootfs_dir) != 0) {
    perror("forge-launcher: chroot");
    close(status_fd);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 3;
  }
  if (chdir("/") != 0) {
    perror("forge-launcher: chdir /");
    close(status_fd);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 3;
  }

  /* ------------------------------------------------------------- *
   * STEP 7: install seccomp BPF filter
   * ------------------------------------------------------------- */
  if (install_seccomp_filter() != 0) {
    perror("forge-launcher: seccomp(SECCOMP_SET_MODE_FILTER)");
    close(status_fd);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 4;
  }

  /* ------------------------------------------------------------- *
   * STEP 8: read observed Seccomp: mode + CapEff: from /proc/self/status
   * ------------------------------------------------------------- */
  int observed_seccomp_mode = -1;
  char cap_eff[64];
  if (parse_proc_status(status_fd, &observed_seccomp_mode, cap_eff,
                        sizeof(cap_eff)) != 0) {
    perror("forge-launcher: parse /proc/self/status");
    close(status_fd);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  close(status_fd);

  /* ------------------------------------------------------------- *
   * STEP 9: getrlimit (observed soft values)
   * ------------------------------------------------------------- */
  struct rlimit cpu_rl, as_rl, nproc_rl, nofile_rl, fsize_rl;
  if (getrlimit(RLIMIT_CPU, &cpu_rl) != 0 ||
      getrlimit(RLIMIT_AS, &as_rl) != 0 ||
      getrlimit(RLIMIT_NPROC, &nproc_rl) != 0 ||
      getrlimit(RLIMIT_NOFILE, &nofile_rl) != 0 ||
      getrlimit(RLIMIT_FSIZE, &fsize_rl) != 0) {
    perror("forge-launcher: getrlimit");
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 10: create pipes for stdout/stderr capture
   * ------------------------------------------------------------- */
  int stdout_pipe[2];
  int stderr_pipe[2];
  if (pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0) {
    perror("forge-launcher: pipe");
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* SHA-256 streams for stdout and stderr. */
  sha256_stream sha_out, sha_err;
  if (sha_stream_init(&sha_out) != 0 || sha_stream_init(&sha_err) != 0) {
    fprintf(stderr, "forge-launcher: SHA-256 init failed\n");
    close(stdout_pipe[0]); close(stdout_pipe[1]);
    close(stderr_pipe[0]); close(stderr_pipe[1]);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 11: fork. Child: dup2 + execvp. Parent: poll+read+forward+hash.
   * ------------------------------------------------------------- */
  pid_t child = fork();
  if (child < 0) {
    perror("forge-launcher: fork");
    close(stdout_pipe[0]); close(stdout_pipe[1]);
    close(stderr_pipe[0]); close(stderr_pipe[1]);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  if (child == 0) {
    /* Child: redirect stdout/stderr to pipe write ends, close read ends. */
    close(stdout_pipe[0]);
    close(stderr_pipe[0]);
    if (dup2(stdout_pipe[1], STDOUT_FILENO) < 0) {
      perror("forge-launcher: dup2 stdout");
      _exit(126);
    }
    if (dup2(stderr_pipe[1], STDERR_FILENO) < 0) {
      perror("forge-launcher: dup2 stderr");
      _exit(126);
    }
    if (stdout_pipe[1] > STDERR_FILENO) close(stdout_pipe[1]);
    if (stderr_pipe[1] > STDERR_FILENO) close(stderr_pipe[1]);

    /* Restore default SIGPIPE handling for the workload. */
    signal(SIGPIPE, SIG_DFL);

    execvp(argv[8], &argv[8]);
    /* If we reach here, execvp failed. */
    fprintf(stderr, "forge-launcher: execvp(%s): %s\n", argv[8],
            strerror(errno));
    _exit(5);
  }

  /* Parent: close write ends. */
  close(stdout_pipe[1]);
  close(stderr_pipe[1]);

  /* Poll both pipes, forward bytes to own stdout/stderr, update SHA-256.
   *
   * CRITICAL: We also check waitpid(WNOHANG) periodically. If the workload
   * exits but orphaned children (e.g., double-forked daemons) hold the pipe
   * write ends open, poll() would never return EOF. By checking waitpid, we
   * can break out of the loop as soon as the workload exits, then do a final
   * non-blocking drain and close the pipes — discarding any data from
   * orphans (which is intentionally not captured). */
  struct pollfd pfds[2];
  pfds[0].fd = stdout_pipe[0];
  pfds[0].events = POLLIN;
  pfds[1].fd = stderr_pipe[0];
  pfds[1].events = POLLIN;
  int open_count = 2;
  char rbuf[READ_BUF_LEN];
  int child_reaped = 0;
  int status = 0;

  while (open_count > 0 && !child_reaped) {
    int pr = poll(pfds, 2, 100); /* 100ms timeout for periodic waitpid checks */
    if (pr < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (pr > 0) {
      for (int i = 0; i < 2; i++) {
        if (pfds[i].fd < 0) continue;
        if (pfds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
          ssize_t n = read(pfds[i].fd, rbuf, sizeof(rbuf));
          if (n > 0) {
            if (i == 0) {
              sha_stream_update(&sha_out, rbuf, (size_t)n);
              write_all(STDOUT_FILENO, rbuf, (size_t)n);
            } else {
              sha_stream_update(&sha_err, rbuf, (size_t)n);
              write_all(STDERR_FILENO, rbuf, (size_t)n);
            }
          } else {
            /* EOF or error. */
            close(pfds[i].fd);
            pfds[i].fd = -1;
            open_count--;
          }
        }
      }
    }
    /* Check if the workload child has exited (non-blocking). */
    pid_t w = waitpid(child, &status, WNOHANG);
    if (w == child) {
      child_reaped = 1;
    } else if (w < 0 && errno != ECHILD) {
      break; /* error */
    }
  }

  /* Final non-blocking drain: the workload may have written data just before
   * exiting. Also handles the case where orphans hold the pipe open — we drain
   * what's available, then close, discarding any future orphan output. */
  for (int i = 0; i < 2; i++) {
    if (pfds[i].fd >= 0) {
      char drain[READ_BUF_LEN];
      int flags = fcntl(pfds[i].fd, F_GETFL, 0);
      if (flags >= 0) {
        fcntl(pfds[i].fd, F_SETFL, flags | O_NONBLOCK);
        while (1) {
          ssize_t n = read(pfds[i].fd, drain, sizeof(drain));
          if (n <= 0) break;
          if (i == 0) {
            sha_stream_update(&sha_out, drain, (size_t)n);
            write_all(STDOUT_FILENO, drain, (size_t)n);
          } else {
            sha_stream_update(&sha_err, drain, (size_t)n);
            write_all(STDERR_FILENO, drain, (size_t)n);
          }
        }
      }
      close(pfds[i].fd);
      pfds[i].fd = -1;
    }
  }

  /* Finalize SHA-256 hashes. */
  if (sha_stream_final(&sha_out) != 0 || sha_stream_final(&sha_err) != 0) {
    fprintf(stderr, "forge-launcher: SHA-256 finalize failed\n");
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 12: waitpid — blocking reap (should be instant if WNOHANG
   *          already reaped the child above).
   * ------------------------------------------------------------- */
  if (!child_reaped) {
    while (waitpid(child, &status, 0) < 0) {
      if (errno == EINTR) continue;
      perror("forge-launcher: waitpid");
      close(facts_fd);
      EVP_PKEY_free(launcher_key);
      return 1;
    }
  }
  int workload_exit_code = -1;
  int workload_signal = 0;
  if (WIFEXITED(status)) {
    workload_exit_code = WEXITSTATUS(status);
  } else if (WIFSIGNALED(status)) {
    workload_signal = WTERMSIG(status);
  }

  /* ------------------------------------------------------------- *
   * STEP 13: build canonicalFactsJson
   * ------------------------------------------------------------- */
  char signed_at[32];
  format_iso_utc(signed_at, sizeof(signed_at));

  size_t canon_len = 0;
  char *canonical = build_canonical_facts(
      user_ns, pid_ns, net_ns, mnt_ns, observed_seccomp_mode, cap_eff,
      cpu_rl.rlim_cur, as_rl.rlim_cur, nproc_rl.rlim_cur, nofile_rl.rlim_cur,
      fsize_rl.rlim_cur, nonce, execution_id, substrate_instance_id,
      workload_exit_code, workload_signal, sha_out.hex, sha_err.hex,
      signed_at, &canon_len);
  if (!canonical) {
    fprintf(stderr, "forge-launcher: build_canonical_facts failed\n");
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 14: sign canonicalFactsJson with Ed25519
   * ------------------------------------------------------------- */
  char sig_hex[SIG_HEX_LEN];
  if (sign_canonical(launcher_key, canonical, canon_len, sig_hex) != 0) {
    fprintf(stderr, "forge-launcher: Ed25519 sign failed\n");
    ERR_print_errors_fp(stderr);
    free(canonical);
    close(facts_fd);
    EVP_PKEY_free(launcher_key);
    return 1;
  }
  EVP_PKEY_free(launcher_key);

  /* ------------------------------------------------------------- *
   * STEP 15: write facts file JSON
   * ------------------------------------------------------------- */
  char created_at[32];
  format_iso_utc(created_at, sizeof(created_at));

  if (write_facts_json(
          facts_fd, user_ns, pid_ns, net_ns, mnt_ns, observed_seccomp_mode,
          cap_eff, cpu_rl.rlim_cur, as_rl.rlim_cur, nproc_rl.rlim_cur,
          nofile_rl.rlim_cur, fsize_rl.rlim_cur, created_at, nonce,
          execution_id, substrate_instance_id, workload_exit_code,
          workload_signal, sha_out.hex, sha_err.hex, canonical, sig_hex,
          signed_at) != 0) {
    fprintf(stderr, "forge-launcher: write facts_json failed\n");
    free(canonical);
    close(facts_fd);
    return 1;
  }

  free(canonical);
  close(facts_fd);

  /* ------------------------------------------------------------- *
   * STEP 16: exit with workload's exit code
   * ------------------------------------------------------------- */
  if (workload_exit_code >= 0) return workload_exit_code;
  if (workload_signal > 0) return 128 + workload_signal;
  return 1;
}
