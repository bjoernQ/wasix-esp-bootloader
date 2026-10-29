#ifndef WASI_LLVM_SYS_IOCTL_H
#define WASI_LLVM_SYS_IOCTL_H
#include_next <sys/ioctl.h>
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
struct winsize {
  unsigned short ws_row;
  unsigned short ws_col;
  unsigned short ws_xpixel;
  unsigned short ws_ypixel;
};
#endif
#endif
