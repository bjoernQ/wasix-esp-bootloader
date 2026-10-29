#ifndef WASI_LLVM_UNISTD_WRAPPER
#define WASI_LLVM_UNISTD_WRAPPER
#include_next <unistd.h>
#ifdef __cplusplus
extern "C" {
#endif
pid_t fork(void);
int execve(const char *, char *const[], char *const[]);
int execv(const char *, char *const[]);
uid_t getuid(void);
uid_t geteuid(void);
pid_t getsid(pid_t);
pid_t setsid(void);
int fchown(int, uid_t, gid_t);
unsigned alarm(unsigned);
#ifdef __cplusplus
}
#endif
#endif
