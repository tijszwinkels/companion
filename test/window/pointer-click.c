// Synthetic click client for the isolated Wayland test; never used by the UI.
#include <assert.h>
#include <string.h>
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
    // BTN_LEFT press/release at the cursor position chosen by the fixture.
    zwlr_virtual_pointer_v1_button(pointer, 0, 272, 1);
    zwlr_virtual_pointer_v1_frame(pointer);
    zwlr_virtual_pointer_v1_button(pointer, 1, 272, 0);
    zwlr_virtual_pointer_v1_frame(pointer);
    wl_display_roundtrip(display);

    zwlr_virtual_pointer_v1_destroy(pointer);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
}
