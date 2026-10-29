#ifndef WASI_LLVM_SYS_RESOURCE_H
#define WASI_LLVM_SYS_RESOURCE_H
#include_next <sys/resource.h>
#include <stdint.h>
#ifndef RLIMIT_DATA
typedef uint64_t rlim_t;
struct rlimit {
  rlim_t rlim_cur;
  rlim_t rlim_max;
};
#define RLIM_INFINITY (~(rlim_t)0)
#define RLIMIT_CPU 0
#define RLIMIT_FSIZE 1
#define RLIMIT_DATA 2
#define RLIMIT_STACK 3
#define RLIMIT_CORE 4
#define RLIMIT_RSS 5
#define RLIMIT_NOFILE 7
#define RLIMIT_AS 9
#ifdef __cplusplus
extern "C" {
#endif
int getrlimit(int, struct rlimit *);
int setrlimit(int, const struct rlimit *);
#ifdef __cplusplus
}
#endif
#endif
#endif
