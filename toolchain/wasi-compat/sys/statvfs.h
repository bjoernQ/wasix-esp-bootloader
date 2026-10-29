#ifndef WASI_LLVM_SYS_STATVFS_H
#define WASI_LLVM_SYS_STATVFS_H
#include_next <sys/statvfs.h>
#ifndef MNT_LOCAL
#define MNT_LOCAL 0x00001000
#endif
#endif
