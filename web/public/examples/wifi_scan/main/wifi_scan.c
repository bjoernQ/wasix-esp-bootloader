#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"
#include "esp_wifi.h"

void app_main(void) {
    int status = esp_wifi_scan();
    printf("scan status: %d\n", status);
    vTaskDelay(1000 / portTICK_PERIOD_MS);
    printf("Restarting now.\n");
    esp_restart();
}
