#pragma once
#ifndef STDIO_H
#define STDIO_H
int printf(const char *fmt, ...);
int fflush(void *stream);
int putchar(int ch);
#define stdout 0
#endif
