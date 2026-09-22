// Synthetic click client for the isolated Wayland test; never used by the UI.
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "pointer.h"

static struct zwlr_virtual_pointer_manager_v1 *manager;

static void global(void *d, struct wl_registry *r, uint32_t name, const char *interface, uint32_t version) {
    if (!strcmp(interface, "zwlr_virtual_pointer_manager_v1")) {
        manager = wl_registry_bind(r, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
    }
}

static void removed(void *d, struct wl_registry *r, uint32_t name) {}

int main(void) {
    struct wl_display *display = wl_display_connect(NULL);
    assert(display);
    struct wl_registry *registry = wl_display_get_registry(display);
    struct wl_registry_listener listener = {global, removed};
    wl_registry_add_listener(registry, &listener, NULL);
    wl_display_roundtrip(display);
    assert(manager);

    struct zwlr_virtual_pointer_v1 *pointer =
        zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, NULL);
    wl_display_roundtrip(display);
    // Keep the device alive so Qt can bind the newly available wl_pointer
    // before input arrives, and popups do not lose their seat between clicks.
    puts("ready");
    fflush(stdout);
    while (getchar() == 'c') {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        uint32_t time = now.tv_sec * 1000u + now.tv_nsec / 1000000u;
        // BTN_LEFT at the cursor position chosen by the fixture.
        zwlr_virtual_pointer_v1_button(pointer, time++, 272, 1);
        zwlr_virtual_pointer_v1_frame(pointer);
        wl_display_roundtrip(display);
        usleep(80000);
        zwlr_virtual_pointer_v1_button(pointer, time + 80, 272, 0);
        zwlr_virtual_pointer_v1_frame(pointer);
        wl_display_roundtrip(display);
        puts("clicked");
        fflush(stdout);
    }

    zwlr_virtual_pointer_v1_destroy(pointer);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
}
