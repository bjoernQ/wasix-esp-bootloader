#ifndef WASI_LLVM_SIGNAL_WRAPPER
#define WASI_LLVM_SIGNAL_WRAPPER
#include_next <signal.h>
#include <stddef.h>

#ifndef SIG_UNBLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif

#ifndef SA_SIGINFO
typedef struct {
  int si_signo;
  int si_errno;
  int si_code;
  int si_pid;
} siginfo_t;

struct sigaction {
  union {
    void (*sa_handler)(int);
    void (*sa_sigaction)(int, siginfo_t *, void *);
  } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction

#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO 4
#define SA_ONSTACK 0x08000000
#define SA_RESTART 0x10000000
#define SA_NODEFER 0x40000000
#define SA_RESETHAND 0x80000000
#define SA_RESTORER 0x04000000

#ifdef __cplusplus
extern "C" {
#endif
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
int kill(pid_t, int);
#ifdef __cplusplus
}
#endif
#endif

#ifndef MINSIGSTKSZ
#define MINSIGSTKSZ 2048
#endif
#ifndef SIGSTKSZ
#define SIGSTKSZ 8192
#endif
#ifndef SS_ONSTACK
#define SS_ONSTACK 1
#endif
#ifndef SS_DISABLE
#define SS_DISABLE 2
typedef struct {
  void *ss_sp;
  int ss_flags;
  size_t ss_size;
} stack_t;
#ifdef __cplusplus
extern "C" {
#endif
int sigaltstack(const stack_t *, stack_t *);
#ifdef __cplusplus
}
#endif
#endif
#endif
