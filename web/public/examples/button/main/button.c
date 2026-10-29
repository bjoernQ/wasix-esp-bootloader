#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED 2
#define BOOT 0

void app_main(void) {
    int level = 0;
    gpio_set_direction(LED, GPIO_MODE_OUTPUT);
    gpio_set_direction(BOOT, GPIO_MODE_INPUT);
    printf("Press BOOT to toggle the LED\n");
    while (1) {
        if (gpio_get_level(BOOT) == 0) {
            level = !level;
            gpio_set_level(LED, level);
            printf("LED %d\n", level);
            vTaskDelay(300 / portTICK_PERIOD_MS);
        }
        vTaskDelay(50 / portTICK_PERIOD_MS);
    }
}
