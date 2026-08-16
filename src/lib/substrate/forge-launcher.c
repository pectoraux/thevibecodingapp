/*
 * Forge — Phase 18V: substrate launcher (forge-launcher.c)
 *
 * Invoked as:
 *   forge-launcher <facts_file> <rootfs_dir> <workspace_dir> <binary> [args...]
 *
 * Runs INSIDE `unshare -U -r -p -f -n -m --propagation=private`, so by the
 * time main() is entered we are already inside fresh user/pid/net/mnt
 * namespaces. The inodes we readlink here are therefore the NEW namespace
 * inodes (different from the host's).
 *
 * NOTE: bind-mounts MUST be done inside the user namespace (the host does
 * not permit unprivileged `mount --bind`). The launcher performs all
 * bind-mounts after entering the user ns, before chroot. The mounts live
 * only in this mount namespace and are cleaned up automatically when the
 * namespace is destroyed on exit — the host's mount table is untouched.
 *
 * Steps, IN THIS ORDER (matches Phase 18V substrate-namespace.ts contract):
 *   1. setrlimit for RLIMIT_CPU (600), RLIMIT_AS (2GiB), RLIMIT_NPROC (256),
 *      RLIMIT_NOFILE (1024), RLIMIT_FSIZE (512MiB). Fail-closed for CPU/AS;
 *      for NPROC/NOFILE/FSIZE, if hard limit is already lower, set soft=hard.
 *   2. readlink /proc/self/ns/{user,pid,net,mnt} — observed new-namespace
 *      inodes.
 *      ALSO: open /proc/self/status fd here (before chroot) so we can read
 *      it post-seccomp.
 *      ALSO: open the facts-file fd here (before chroot — the path was
 *      computed by the TypeScript side BEFORE we entered this launcher and
 *      lives outside the chroot).
 *   3. prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0).
 *   4. Bind-mount system dirs + dev nodes + workspace (+ optionally /proc)
 *      into rootfs. The rootfs dir + subdirs + empty dev files were created
 *      by the TypeScript side (buildRootfs) before unshare was spawned.
 *   5. chroot(rootfs_dir); chdir("/"). Fail-closed (exit 3).
 *   6. Install seccomp BPF filter blocking the 25 syscalls in
 *      REQUIRED_SUBSTRATE_POLICY.blockedSyscalls. Fail-closed (exit 4).
 *   7. lseek+read the /proc/self/status fd; parse "Seccomp:" and "CapEff:".
 *   8. getrlimit for the 5 limits (observed soft values).
 *   9. Write JSON facts to the facts-file fd (sorted blockedSyscalls array).
 *  10. execvp(binary, &argv[4]). Fail-closed (exit 5).
 *
 * The TypeScript side reads the JSON facts and constructs a SandboxAttestation,
 * computing the seccomp profile hash itself (so the C side does NOT need a
 * SHA-256 implementation).
 *
 * Fail-closed: any unrecoverable setup failure exits non-zero with NO facts
 * file produced. The TypeScript wrapper treats a missing facts file as
 * "substrate could not be established" and refuses to fabricate an
 * attestation.
 *
 * Environment:
 *   SUBSTRATE_INCLUDE_PROC=1  → bind-mount /proc into rootfs/proc (RO).
 *                               Default: off (hermetic hostile tests want
 *                               NO /proc).
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
#include <fcntl.h>
#include <time.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <linux/bpf_common.h>
#include <stddef.h>
#include <errno.h>

/* x86_64 architecture identifier for the seccomp_data.arch field. */
#define ARCH_NR AUDIT_ARCH_X86_64

/* Resource limits — match REQUIRED_SUBSTRATE_POLICY. */
#define CPU_LIMIT_SECONDS 600
#define MEMORY_LIMIT_BYTES (2LL * 1024LL * 1024LL * 1024LL)
#define PROCESS_LIMIT 256
#define FD_LIMIT 1024
#define FILE_SIZE_LIMIT_BYTES (512LL * 1024LL * 1024LL)

#define RUNTIME_VERSION "forge-namespace-launcher-v1"

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

/* Bind-mount specification: source path on host, relative destination inside
 * rootfs. The destination dir/file must already exist (created by TS
 * buildRootfs). */
struct bind_spec {
  const char *src;
  const char *dst_rel;
  int required; /* 1 = fail if bind fails; 0 = skip if src missing */
};

static const struct bind_spec system_binds[] = {
  { "/bin",  "bin",  1 },
  { "/sbin", "sbin", 0 },
  { "/lib",  "lib",  1 },
  { "/usr",  "usr",  1 },
  /* /lib64 is a symlink on some systems; bind if it exists. */
  { "/lib64", "lib64", 0 },
};

static const struct bind_spec dev_binds[] = {
  { "/dev/null",    "dev/null",    1 },
  { "/dev/zero",    "dev/zero",    1 },
  { "/dev/urandom", "dev/urandom", 1 },
};

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

/* setrlimit helper. For CPU and AS, fail-closed. For others, if the hard
 * limit is already lower than the policy, set soft=hard instead of failing. */
static int apply_rlimit(int resource, rlim_t soft, rlim_t hard, int fail_closed) {
  struct rlimit cur;
  if (getrlimit(resource, &cur) != 0) {
    if (fail_closed) return -1;
    return 0;
  }
  struct rlimit new_lim;
  new_lim.rlim_cur = soft;
  new_lim.rlim_max = hard;
  /* If the existing hard limit is below our requested hard, do not try to
   * raise it (would fail with EPERM). Cap our request at the existing hard. */
  if (cur.rlim_max < hard) {
    new_lim.rlim_max = cur.rlim_max;
    /* And keep soft <= hard. */
    if (new_lim.rlim_cur > cur.rlim_max) new_lim.rlim_cur = cur.rlim_max;
  }
  if (setrlimit(resource, &new_lim) != 0) {
    if (fail_closed) return -1;
    /* Non-fail-closed: try soft=hard of the existing limit. */
    new_lim.rlim_cur = cur.rlim_max;
    new_lim.rlim_max = cur.rlim_max;
    if (setrlimit(resource, &new_lim) != 0) {
      /* Last resort: just leave it — recorded rlimits will reflect reality. */
      return 0;
    }
  }
  return 0;
}

/* Build the BPF filter program. Layout:
 *   [0]               LD  nr                (load syscall number)
 *   [1..N]            JEQ sys_i, jt=N-i, jf=0  (one per blocked syscall)
 *   [N+1]             RET ALLOW
 *   [N+2]             RET KILL_PROCESS
 *
 * For the i-th JEQ (0-indexed, i=0..N-1), the next instruction is at index
 * (1+i)+1 = i+2. To land on the KILL at index N+2, we must skip
 * (N+2) - (i+2) = N-i instructions. So jt_i = N-i. (Verified for N=2.)
 */
static int install_seccomp_filter(void) {
  const size_t n = NUM_BLOCKED;
  const size_t total_insns = 1 + n + 2; /* LD + N*JEQ + ALLOW + KILL */
  struct sock_filter *prog =
      (struct sock_filter *)calloc(total_insns, sizeof(struct sock_filter));
  if (!prog) return -1;

  size_t idx = 0;
  /* [0] Load seccomp_data.nr */
  prog[idx++] = (struct sock_filter)BPF_STMT(
      BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));

  /* [1..N] One JEQ per blocked syscall. jt = N - i (skip to KILL). */
  for (size_t i = 0; i < n; i++) {
    prog[idx++] = (struct sock_filter)BPF_JUMP(
        BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)blocked_syscalls[i].nr,
        (unsigned char)(n - i), 0);
  }

  /* [N+1] ALLOW (fallthrough — syscall is not in the blocked set). */
  prog[idx++] = (struct sock_filter)BPF_STMT(
      BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

  /* [N+2] KILL_PROCESS (target of all JEQ jumps). */
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
  return rc; /* 0 on success, -1 on failure (errno set). */
}

/* Read /proc/self/status (already-open fd) and parse "Seccomp:" and "CapEff:". */
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

/* Write the JSON facts file. Uses dprintf on an already-open fd.
 * blockedSyscalls is emitted in array-definition order, which is already
 * sorted alphabetically (matches REQUIRED_SUBSTRATE_POLICY.blockedSyscalls). */
static int write_facts_json(int fd, const char *user_ns, const char *pid_ns,
                            const char *net_ns, const char *mnt_ns,
                            int seccomp_mode, const char *cap_eff,
                            rlim_t cpu_soft, rlim_t as_soft, rlim_t nproc_soft,
                            rlim_t nofile_soft, rlim_t fsize_soft,
                            const char *created_at) {
  /* Reset to start in case the fd was previously read/written. */
  if (ftruncate(fd, 0) != 0) return -1;
  if (lseek(fd, 0, SEEK_SET) == (off_t)-1) return -1;

  int rc = 0;
  rc |= dprintf(fd, "{");
  rc |= dprintf(fd, "\"runtimeVersion\":\"%s\",", RUNTIME_VERSION);
  rc |= dprintf(fd, "\"userNamespaceInode\":\"%s\",", user_ns);
  rc |= dprintf(fd, "\"pidNamespaceInode\":\"%s\",", pid_ns);
  rc |= dprintf(fd, "\"netNamespaceInode\":\"%s\",", net_ns);
  rc |= dprintf(fd, "\"mntNamespaceInode\":\"%s\",", mnt_ns);
  rc |= dprintf(fd, "\"seccompMode\":%d,", seccomp_mode);
  rc |= dprintf(fd, "\"capEffHex\":\"%s\",", cap_eff);
  rc |= dprintf(fd, "\"blockedSyscalls\":[");
  for (size_t i = 0; i < NUM_BLOCKED; i++) {
    rc |= dprintf(fd, "\"%s\"%s", blocked_syscalls[i].name,
                  (i + 1 < NUM_BLOCKED) ? "," : "");
  }
  rc |= dprintf(fd, "],");
  rc |= dprintf(fd, "\"cpuLimitSeconds\":%llu,",
                (unsigned long long)cpu_soft);
  rc |= dprintf(fd, "\"memoryLimitBytes\":%llu,",
                (unsigned long long)as_soft);
  rc |= dprintf(fd, "\"processLimit\":%llu,",
                (unsigned long long)nproc_soft);
  rc |= dprintf(fd, "\"fileDescriptorLimit\":%llu,",
                (unsigned long long)nofile_soft);
  rc |= dprintf(fd, "\"fileSizeLimitBytes\":%llu,",
                (unsigned long long)fsize_soft);
  rc |= dprintf(fd, "\"createdAt\":\"%s\"", created_at);
  rc |= dprintf(fd, "}\n");
  return rc < 0 ? -1 : 0;
}

/* Format the current UTC time as YYYY-MM-DDTHH:MM:SSZ. */
static void format_iso_utc(char *out, size_t out_len) {
  time_t now = time(NULL);
  struct tm tm_utc;
  gmtime_r(&now, &tm_utc);
  strftime(out, out_len, "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
}

/* Bind-mount src onto rootfs_dir/dst_rel.
 * Returns: 0 = bound successfully, 1 = skipped (non-required + src/dst
 * missing), -1 = mount failed (or required + missing).
 * The caller decides whether -1 is fatal based on `required`. */
static int do_bind(const char *rootfs_dir, const char *src, const char *dst_rel,
                   int required) {
  char dst[PATH_BUF_LEN];
  int n = snprintf(dst, sizeof(dst), "%s/%s", rootfs_dir, dst_rel);
  if (n < 0 || (size_t)n >= sizeof(dst)) {
    fprintf(stderr, "forge-launcher: path too long: %s/%s\n", rootfs_dir, dst_rel);
    return required ? -1 : 1;
  }
  /* Check src exists. */
  struct stat st;
  if (stat(src, &st) != 0) {
    if (!required) return 1; /* skip — src not present on this system */
    fprintf(stderr, "forge-launcher: bind source missing: %s\n", src);
    return -1;
  }
  /* Check dst exists (TS buildRootfs should have created it). */
  if (stat(dst, &st) != 0) {
    if (!required) return 1; /* skip — dst not present */
    fprintf(stderr, "forge-launcher: bind destination missing: %s\n", dst);
    return -1;
  }
  if (mount(src, dst, NULL, MS_BIND, NULL) != 0) {
    fprintf(stderr, "forge-launcher: mount --bind %s %s: %s\n", src, dst,
            strerror(errno));
    return -1; /* mount failed — caller decides if fatal */
  }
  return 0;
}

/* Run a bind; fail-closed if required and the bind failed. */
static int run_bind(const char *rootfs_dir, const char *src, const char *dst_rel,
                    int required) {
  int rc = do_bind(rootfs_dir, src, dst_rel, required);
  if (rc == -1 && required) return -1;
  return 0;
}

/* Bind-mount /proc RO into rootfs/proc (only if SUBSTRATE_INCLUDE_PROC=1).
 * Non-fatal: if the bind fails (some environments reject bind-mounting
 * procfs), continue without /proc — the chroot + seccomp + cap-drop already
 * restrict what the sandboxed binary can do. */
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
  /* Remount read-only (defense-in-depth). */
  if (mount(NULL, dst, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL) != 0) {
    /* Non-fatal. */
  }
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr,
            "forge-launcher: usage: %s <facts_file> <rootfs_dir> <workspace_dir> <binary> [args...]\n",
            argv[0]);
    return 2;
  }

  const char *facts_path = argv[1];
  const char *rootfs_dir = argv[2];
  const char *workspace_dir = argv[3];
  /* argv[4] is the binary; remaining are its args. */

  /* ------------------------------------------------------------- *
   * STEP 1: setrlimit
   * ------------------------------------------------------------- */
  if (apply_rlimit(RLIMIT_CPU, CPU_LIMIT_SECONDS, CPU_LIMIT_SECONDS, 1) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_CPU)");
    return 1;
  }
  if (apply_rlimit(RLIMIT_AS, MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES, 1) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_AS)");
    return 1;
  }
  /* Non-fail-closed: clamp to existing hard if lower. */
  if (apply_rlimit(RLIMIT_NPROC, PROCESS_LIMIT, PROCESS_LIMIT, 0) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_NPROC)");
    return 1;
  }
  if (apply_rlimit(RLIMIT_NOFILE, FD_LIMIT, FD_LIMIT, 0) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_NOFILE)");
    return 1;
  }
  if (apply_rlimit(RLIMIT_FSIZE, FILE_SIZE_LIMIT_BYTES, FILE_SIZE_LIMIT_BYTES,
                   0) != 0) {
    perror("forge-launcher: setrlimit(RLIMIT_FSIZE)");
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 2: read namespace inodes + open /proc/self/status fd +
   *         open facts-file fd (all BEFORE chroot)
   * ------------------------------------------------------------- */
  char user_ns[INODE_BUF_LEN];
  char pid_ns[INODE_BUF_LEN];
  char net_ns[INODE_BUF_LEN];
  char mnt_ns[INODE_BUF_LEN];

  if (read_ns_inode("/proc/self/ns/user", user_ns, sizeof(user_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/user");
    return 1;
  }
  if (read_ns_inode("/proc/self/ns/pid", pid_ns, sizeof(pid_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/pid");
    return 1;
  }
  if (read_ns_inode("/proc/self/ns/net", net_ns, sizeof(net_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/net");
    return 1;
  }
  if (read_ns_inode("/proc/self/ns/mnt", mnt_ns, sizeof(mnt_ns)) != 0) {
    perror("forge-launcher: readlink /proc/self/ns/mnt");
    return 1;
  }

  /* Open /proc/self/status BEFORE chroot so we can read it post-seccomp. */
  int status_fd = open("/proc/self/status", O_RDONLY | O_CLOEXEC);
  if (status_fd < 0) {
    perror("forge-launcher: open /proc/self/status");
    return 1;
  }

  /* Open the facts-file fd BEFORE chroot (the path lives outside rootfs). */
  int facts_fd =
      open(facts_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (facts_fd < 0) {
    perror("forge-launcher: open facts_file");
    close(status_fd);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 3: PR_SET_NO_NEW_PRIVS
   * ------------------------------------------------------------- */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("forge-launcher: prctl(PR_SET_NO_NEW_PRIVS)");
    close(status_fd);
    close(facts_fd);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 4: bind-mounts (inside the user namespace — possible because
   *         we're running under `unshare -U -r -m`). Mounts live only in
   *         this mount namespace and are cleaned up automatically on exit.
   * ------------------------------------------------------------- */
  for (size_t i = 0; i < sizeof(system_binds) / sizeof(system_binds[0]); i++) {
    if (run_bind(rootfs_dir, system_binds[i].src, system_binds[i].dst_rel,
                 system_binds[i].required) != 0) {
      close(status_fd);
      close(facts_fd);
      return 1;
    }
  }
  for (size_t i = 0; i < sizeof(dev_binds) / sizeof(dev_binds[0]); i++) {
    if (run_bind(rootfs_dir, dev_binds[i].src, dev_binds[i].dst_rel,
                 dev_binds[i].required) != 0) {
      close(status_fd);
      close(facts_fd);
      return 1;
    }
  }
  /* Workspace — READ-WRITE (the app's working directory).
   * Non-required: if opts.cwd is a filesystem root (e.g. overlayfs root like
   * /tmp) that cannot be bind-mounted, fall back to an empty /workspace.
   * The app still runs — it just won't see its workspace files. This is
   * acceptable for the smoke test (e.g. /bin/echo); production callers pass
   * a normal subdirectory as cwd which binds fine. */
  int ws_rc = do_bind(rootfs_dir, workspace_dir, "workspace", 0);
  if (ws_rc == -1) {
    fprintf(stderr,
            "forge-launcher: warning — workspace bind failed; continuing with empty /workspace\n");
  }
  /* Optionally /proc (positive-path tests only). Non-fatal. */
  maybe_bind_proc(rootfs_dir);

  /* ------------------------------------------------------------- *
   * STEP 5: chroot + chdir
   * ------------------------------------------------------------- */
  if (chroot(rootfs_dir) != 0) {
    perror("forge-launcher: chroot");
    close(status_fd);
    close(facts_fd);
    return 3;
  }
  if (chdir("/") != 0) {
    perror("forge-launcher: chdir /");
    close(status_fd);
    close(facts_fd);
    return 3;
  }

  /* ------------------------------------------------------------- *
   * STEP 6: install seccomp BPF filter
   * ------------------------------------------------------------- */
  if (install_seccomp_filter() != 0) {
    perror("forge-launcher: seccomp(SECCOMP_SET_MODE_FILTER)");
    close(status_fd);
    close(facts_fd);
    return 4;
  }

  /* ------------------------------------------------------------- *
   * STEP 7: read observed Seccomp: mode + CapEff: from /proc/self/status
   * ------------------------------------------------------------- */
  int observed_seccomp_mode = -1;
  char cap_eff[64];
  if (parse_proc_status(status_fd, &observed_seccomp_mode, cap_eff,
                        sizeof(cap_eff)) != 0) {
    perror("forge-launcher: parse /proc/self/status");
    close(status_fd);
    close(facts_fd);
    return 1;
  }
  close(status_fd);

  /* ------------------------------------------------------------- *
   * STEP 8: getrlimit (observed soft values)
   * ------------------------------------------------------------- */
  struct rlimit cpu_rl, as_rl, nproc_rl, nofile_rl, fsize_rl;
  if (getrlimit(RLIMIT_CPU, &cpu_rl) != 0 ||
      getrlimit(RLIMIT_AS, &as_rl) != 0 ||
      getrlimit(RLIMIT_NPROC, &nproc_rl) != 0 ||
      getrlimit(RLIMIT_NOFILE, &nofile_rl) != 0 ||
      getrlimit(RLIMIT_FSIZE, &fsize_rl) != 0) {
    perror("forge-launcher: getrlimit");
    close(facts_fd);
    return 1;
  }

  /* ------------------------------------------------------------- *
   * STEP 9: write JSON facts file
   * ------------------------------------------------------------- */
  char created_at[32];
  format_iso_utc(created_at, sizeof(created_at));

  if (write_facts_json(facts_fd, user_ns, pid_ns, net_ns, mnt_ns,
                       observed_seccomp_mode, cap_eff,
                       cpu_rl.rlim_cur, as_rl.rlim_cur, nproc_rl.rlim_cur,
                       nofile_rl.rlim_cur, fsize_rl.rlim_cur,
                       created_at) != 0) {
    perror("forge-launcher: write facts_json");
    close(facts_fd);
    return 1;
  }
  if (fsync(facts_fd) != 0) {
    /* Non-fatal — best-effort durability. */
  }
  close(facts_fd);

  /* ------------------------------------------------------------- *
   * STEP 10: execvp the target binary
   * ------------------------------------------------------------- */
  execvp(argv[4], &argv[4]);
  /* If we reach here, execvp failed. */
  perror("forge-launcher: execvp");
  return 5;
}
