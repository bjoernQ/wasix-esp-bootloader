#pragma once
#ifndef DRIVER_GPIO_H
#define DRIVER_GPIO_H
#define GPIO_MODE_INPUT 1
#define GPIO_MODE_OUTPUT 2
void gpio_set_direction(int pin, int mode);
void gpio_set_level(int pin, int level);
int gpio_get_level(int pin);
#endif
