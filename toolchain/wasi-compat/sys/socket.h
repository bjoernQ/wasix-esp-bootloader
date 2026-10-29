#ifndef WASI_LLVM_SYS_SOCKET_H
#define WASI_LLVM_SYS_SOCKET_H
#include_next <sys/socket.h>
#ifdef __cplusplus
extern "C" {
#endif
int socket(int, int, int);
int connect(int, const struct sockaddr *, socklen_t);
int bind(int, const struct sockaddr *, socklen_t);
int listen(int, int);
#ifdef __cplusplus
}
#endif
#endif
