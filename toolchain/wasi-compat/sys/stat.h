#ifndef WASI_LLVM_SYS_STAT_H
#define WASI_LLVM_SYS_STAT_H
#include_next <sys/stat.h>
#ifdef __cplusplus
extern "C" {
#endif
mode_t umask(mode_t);
#ifdef __cplusplus
}
#endif
#endif
