#ifndef WASI_LLVM_SYS_WAIT_H
#define WASI_LLVM_SYS_WAIT_H
#include <sys/types.h>
struct rusage;
#define WNOHANG 1
#define WUNTRACED 2
#define WEXITED 4
#define WNOWAIT 8
#ifndef WIFEXITED
#define WTERMSIG(s) ((s) & 0x7f)
#define WIFEXITED(s) (WTERMSIG(s) == 0)
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WIFSIGNALED(s) (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#endif
#ifdef __cplusplus
extern "C" {
#endif
pid_t wait(int *);
pid_t wait4(pid_t, int *, int, struct rusage *);
#ifdef __cplusplus
}
#endif
#endif
