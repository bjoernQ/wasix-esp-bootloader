#ifndef WASI_LLVM_DLFCN_H
#define WASI_LLVM_DLFCN_H
#include_next <dlfcn.h>
#if !defined(__wasilibc_unmodified_upstream)
typedef struct {
  const char *dli_fname;
  void *dli_fbase;
  const char *dli_sname;
  void *dli_saddr;
} Dl_info;
#ifdef __cplusplus
extern "C" {
#endif
int dladdr(const void *, Dl_info *);
#ifdef __cplusplus
}
#endif
#endif
#endif
