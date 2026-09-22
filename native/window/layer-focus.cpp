#include "layer-focus.hpp"

#include <QGuiApplication>
#include <QPointer>
#include <QWindow>

#ifdef COMPANION_LAYER_SHELL
#include <QWaylandClientExtension>
#include <qpa/qplatformnativeinterface.h>
#include "qwayland-hyprland-focus-grab-v1.h"

namespace {
class Manager : public QWaylandClientExtensionTemplate<Manager>,
                public QtWayland::hyprland_focus_grab_manager_v1 {
public:
    Manager() : QWaylandClientExtensionTemplate(1) { initialize(); }
    ~Manager() override { if (isInitialized()) destroy(); }
};

class Grab : public QObject, public QtWayland::hyprland_focus_grab_v1 {
    Q_OBJECT
public:
    explicit Grab(::hyprland_focus_grab_v1 *object)
        : QtWayland::hyprland_focus_grab_v1(object) {}
    ~Grab() override { if (isInitialized()) destroy(); }
signals:
    void cleared();
protected:
    void hyprland_focus_grab_v1_cleared() override { emit cleared(); }
};
}
#endif

struct LayerFocus::State {
    QPointer<QWindow> window;
#ifdef COMPANION_LAYER_SHELL
    std::unique_ptr<Manager> manager;
    QPointer<Grab> grab;
#endif
};

LayerFocus::LayerFocus(QObject *parent) : QObject(parent), state(std::make_unique<State>()) {
#ifdef COMPANION_LAYER_SHELL
    // Offscreen tests and ordinary non-Wayland hosts have no Wayland display.
    if (QGuiApplication::platformName().startsWith("wayland")) {
        state->manager = std::make_unique<Manager>();
        connect(state->manager.get(), &QWaylandClientExtension::activeChanged, this, [this] {
            if (state->manager->isActive()) begin();
            else { release(); emit cleared(); }
        });
    }
#endif
}

LayerFocus::~LayerFocus() { release(); }

void LayerFocus::acquire(QWindow *window) {
    release();
    state->window = window;
    begin();
}

void LayerFocus::begin() {
#ifdef COMPANION_LAYER_SHELL
    if (!state->window || !state->window->isVisible() || state->grab
        || !state->manager || !state->manager->isActive()) return;
    auto *native = QGuiApplication::platformNativeInterface();
    auto *surface = static_cast<wl_surface *>(native->nativeResourceForWindow("surface", state->window));
    if (!surface) return;
    auto *grab = new Grab(state->manager->create_grab());
    grab->setParent(this);
    state->grab = grab;
    connect(grab, &Grab::cleared, this, [this, grab] {
        if (state->grab != grab) return;
        release();
        emit cleared();
    });
    grab->add_surface(surface);
    grab->commit();
#endif
}

void LayerFocus::release() {
    state->window.clear();
#ifdef COMPANION_LAYER_SHELL
    if (!state->grab) return;
    auto *grab = state->grab.data();
    state->grab.clear();
    grab->disconnect(this);
    // Send the release now, before focus restoration is forwarded to another
    // client. Delete later because this may run inside the cleared event.
    grab->destroy();
    grab->deleteLater();
#endif
}

#ifdef COMPANION_LAYER_SHELL
#include "layer-focus.moc"
#endif
