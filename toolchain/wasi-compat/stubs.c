#include <dlfcn.h>
#include <errno.h>
#include <pwd.h>
#include <signal.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef WASIX_SPAWN
pid_t fork(void) {
  errno = ENOSYS;
  return -1;
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  (void)path;
  (void)argv;
  (void)envp;
  errno = ENOSYS;
  return -1;
}

int execv(const char *path, char *const argv[]) {
  (void)path;
  (void)argv;
  errno = ENOSYS;
  return -1;
}

pid_t wait(int *status) {
  (void)status;
  errno = ECHILD;
  return -1;
}

pid_t wait4(pid_t pid, int *status, int options, struct rusage *usage) {
  (void)pid;
  (void)status;
  (void)options;
  (void)usage;
  errno = ECHILD;
  return -1;
}
#endif

int sigaction(int sig, const struct sigaction *act, struct sigaction *old) {
  (void)sig;
  (void)act;
  if (old)
    memset(old, 0, sizeof(*old));
  errno = ENOSYS;
  return -1;
}

int sigemptyset(sigset_t *set) {
  memset(set, 0, sizeof(*set));
  return 0;
}

int sigfillset(sigset_t *set) {
  memset(set, 0xff, sizeof(*set));
  return 0;
}

int sigaddset(sigset_t *set, int sig) {
  (void)set;
  (void)sig;
  return 0;
}

int sigdelset(sigset_t *set, int sig) {
  (void)set;
  (void)sig;
  return 0;
}

int sigismember(const sigset_t *set, int sig) {
  (void)set;
  (void)sig;
  return 0;
}

int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
  (void)how;
  (void)set;
  if (old)
    memset(old, 0, sizeof(*old));
  return 0;
}

int kill(pid_t pid, int sig) {
  (void)pid;
  (void)sig;
  errno = ENOSYS;
  return -1;
}

int sigaltstack(const stack_t *ss, stack_t *old) {
  (void)ss;
  if (old)
    memset(old, 0, sizeof(*old));
  return 0;
}

uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
pid_t getsid(pid_t pid) {
  (void)pid;
  return 1;
}

pid_t setsid(void) { return 1; }

int fchown(int fd, uid_t owner, gid_t group) {
  (void)fd;
  (void)owner;
  (void)group;
  return 0;
}

int flock(int fd, int operation) {
  (void)fd;
  (void)operation;
  return 0;
}

unsigned alarm(unsigned seconds) {
  (void)seconds;
  return 0;
}

mode_t umask(mode_t mask) {
  (void)mask;
  return 0;
}

int socket(int domain, int type, int protocol) {
  (void)domain;
  (void)type;
  (void)protocol;
  errno = ENOSYS;
  return -1;
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  (void)fd;
  (void)addr;
  (void)len;
  errno = ENOSYS;
  return -1;
}

int bind(int fd, const struct sockaddr *addr, socklen_t len) {
  (void)fd;
  (void)addr;
  (void)len;
  errno = ENOSYS;
  return -1;
}

int listen(int fd, int backlog) {
  (void)fd;
  (void)backlog;
  errno = ENOSYS;
  return -1;
}

int posix_madvise(void *addr, size_t len, int advice) {
  (void)addr;
  (void)len;
  (void)advice;
  return 0;
}

int dladdr(const void *addr, Dl_info *info) {
  (void)addr;
  if (info)
    memset(info, 0, sizeof(*info));
  return 0;
}

int setrlimit(int resource, const struct rlimit *rlim) {
  (void)resource;
  (void)rlim;
  return 0;
}

int getrlimit(int resource, struct rlimit *rlim) {
  (void)resource;
  if (rlim)
    memset(rlim, 0, sizeof(*rlim));
  return 0;
}

int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result) {
  (void)name;
  (void)pwd;
  (void)buf;
  (void)buflen;
  if (result)
    *result = 0;
  return -1;
}

int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result) {
  (void)uid;
  (void)pwd;
  (void)buf;
  (void)buflen;
  if (result)
    *result = 0;
  return -1;
}
