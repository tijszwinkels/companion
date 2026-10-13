#include "host.hpp"

#include <QCloseEvent>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QScreen>
#include <QPlatformSurfaceEvent>
#include <QTimer>
#include <algorithm>
#ifdef COMPANION_LAYER_SHELL
#include <LayerShellQt/Window>
#endif

namespace {
// Qt's Wayland backend reports a whole output as available: it cannot see the
// exclusive zones of panels such as Omarchy's top bar, or the compositor's gaps.
// A remembered Window size keeps this much room for them before mapping.
constexpr int compositorPanelAllowance = 64;
}

WindowHost::WindowHost(QObject *parent, bool testSurfaces) : QObject(parent), testSurfaces(testSurfaces) {
    connect(&layerFocus, &LayerFocus::cleared, this, &WindowHost::focusCleared);
    ordinary.setTitle("Companion");
    ordinary.setMinimumSize(QSize(360, 420));
    ordinary.resize(settings.value("window/width", 620).toInt(),
                    settings.value("window/height", 780).toInt());
    sidebar.setTitle("Companion sidebar");
    sidebar.setFlags(Qt::FramelessWindowHint | Qt::Window);
    for (auto *surface : {&ordinary, &sidebar}) {
        surface->installEventFilter(this);
        connect(surface, &QWindow::activeChanged, this, &WindowHost::stateChanged);
        connect(surface, &QWindow::visibleChanged, this, &WindowHost::stateChanged);
        connect(surface, &QWindow::screenChanged, this, &WindowHost::screensChanged);
    }
    connect(&ordinary, &QWindow::widthChanged, this, [this](int value) {
        if (ordinary.isVisible()) settings.setValue("window/width", value);
    });
    connect(&ordinary, &QWindow::heightChanged, this, [this](int value) {
        if (ordinary.isVisible()) settings.setValue("window/height", value);
    });
    sidebarWidth = std::clamp(settings.value("sidebar/width", 600).toInt(), 360, 1600);
    connect(&server, &QLocalServer::newConnection, this, &WindowHost::accept);
    connect(qGuiApp, &QGuiApplication::screenRemoved, this, &WindowHost::screensChanged);
    for (auto *screen : QGuiApplication::screens()) {
        connect(screen, &QScreen::geometryChanged, this, &WindowHost::screensChanged);
    }
    connect(qGuiApp, &QGuiApplication::screenAdded, this, [this](QScreen *screen) {
        connect(screen, &QScreen::geometryChanged, this, &WindowHost::screensChanged);
        screensChanged();
    });
    // A monitor change reaches Qt before the compositor has moved or re-tiled
    // the Window. Check its fit once the changes have settled.
    windowRefit.setSingleShot(true);
    windowRefit.setInterval(500);
    connect(&windowRefit, &QTimer::timeout, this, &WindowHost::refitVisibleWindow);
}

WindowHost::~WindowHost() {
    // The QML engine owns the body and destroys it before this host's windows.
    server.close();
    for (auto *client : clients.keys()) {
        client->disconnect(this);
        delete client;
    }
}

QQuickWindow *WindowHost::window() const {
    return const_cast<QQuickWindow *>(mode == "window" ? &ordinary : &sidebar);
}

QQuickItem *WindowHost::contentItem() const { return window()->contentItem(); }
bool WindowHost::opened() const { return window()->isVisible(); }
bool WindowHost::active() const { return opened() && window()->isActive(); }
QString WindowHost::presentation() const { return mode; }
bool WindowHost::bridgeConnected() const { return !bridge.isNull(); }

bool WindowHost::sidebarAvailable() const {
    // The QtTest runner exercises body reparenting with ordinary offscreen
    // surfaces. Production has no environment/command switch for this seam.
    if (testSurfaces) return true;
#ifdef COMPANION_LAYER_SHELL
    return QGuiApplication::platformName().startsWith("wayland");
#else
    return false;
#endif
}

bool WindowHost::listen(const QString &path) {
    server.setSocketOptions(QLocalServer::UserAccessOption);
    return server.listen(path);
}

void WindowHost::attach(QQuickItem *item) {
    body = item;
    body->setParentItem(contentItem());
}

void WindowHost::show(bool focus) {
    if (mode == "window") fitOrdinary();
    else updateSidebar();
    window()->show();
    if (focus) activate();
}

void WindowHost::hide() { releaseFocus(); window()->hide(); }
void WindowHost::activate() {
    if (mode != "window" && !testSurfaces) layerFocus.acquire(window());
    window()->requestActivate();
}
void WindowHost::releaseFocus() { layerFocus.release(); }

void WindowHost::setError(const QString &message) {
    failure = message;
    emit errorChanged();
}

void WindowHost::setPresentation(const QString &value) {
    if (value != "window" && value != "sidebar" && value != "dock") {
        setError("Choose Window, Sidebar or Dock.");
        return;
    }
    if (value != "window" && !sidebarAvailable()) {
        setError("Sidebar and Dock require Wayland and the LayerShellQt package.");
        return;
    }
    if (value == mode) {
        // Reasserting a valid mode is also recovery from a rejected request.
        // This matters on window-only hosts where no other mode can succeed.
        setError("");
        return;
    }
    replaceSurface([&] {
        mode = value;
        settings.setValue("presentation", mode);
        updateSidebar();
        if (body) body->setParentItem(contentItem());
        emit surfaceChanged();
        emit placementChanged();
        setError("");
    });
}

void WindowHost::replaceSurface(const std::function<void()> &change) {
    // Hide the current surface, apply the change, then show the resulting one
    // with the previous visibility and keyboard focus. The QML body only changes
    // parent, so drafts, tabs and browser documents stay in place.
    const bool visible = opened();
    const bool focused = active();
    QPointer<QQuickItem> focusItem = window()->activeFocusItem();
    changingSurface = true;
    releaseFocus();
    window()->hide();
    change();
    if (visible) {
        show(focused);
        if (focusItem) focusItem->forceActiveFocus(Qt::OtherFocusReason);
    }
    changingSurface = false;
    emit stateChanged();
}

void WindowHost::screensChanged() {
    updateSidebar();
    if (mode == "window") windowRefit.start();
}

void WindowHost::refitVisibleWindow() {
    // Hyprland keeps a floating window's size when a monitor change moves it,
    // and a Qt resize of a mapped window would leave the outer window at the
    // old size. Showing it again lets the compositor place the fitted size.
    if (mode != "window" || !ordinary.isVisible()) return;
    // The compositor sizes maximized and full-screen windows to the output.
    if (ordinary.windowStates() & (Qt::WindowMaximized | Qt::WindowFullScreen)) return;
    const QScreen *screen = ordinary.screen();
    if (!screen) return;
    const QSize bounds = ordinaryBounds(screen);
    if (ordinary.width() <= bounds.width() && ordinary.height() <= bounds.height()) return;
    replaceSurface([] {});
}

QString WindowHost::sidebarScreen() const {
    return mode != "window" && placedScreen ? placedScreen->name() : QString();
}

QScreen *WindowHost::preferredSidebarScreen() const {
    // Match Companion's existing sidebar policy: prefer external screens, then
    // the rightmost logical edge, with a stable name tie-break for mirroring.
    const QRegularExpression builtIn("^(eDP|LVDS|DSI)(-|$)", QRegularExpression::CaseInsensitiveOption);
    auto screens = QGuiApplication::screens();
    const bool hasExternal = std::any_of(screens.begin(), screens.end(), [&](QScreen *screen) {
        return !builtIn.match(screen->name()).hasMatch();
    });
    QScreen *screen = nullptr;
    for (auto *candidate : screens) {
        if (hasExternal && builtIn.match(candidate->name()).hasMatch()) continue;
        if (!screen || candidate->geometry().right() > screen->geometry().right()
            || (candidate->geometry().right() == screen->geometry().right() && candidate->name() < screen->name())) {
            screen = candidate;
        }
    }
    return screen;
}

void WindowHost::updateSidebar() {
    if (mode == "window" || !sidebarAvailable()) return;
    QScreen *screen = preferredSidebarScreen();
    if (!screen) return;
    if (sidebar.isVisible() && screen != placedScreen) {
        // LayerShellQt chooses a layer surface's output only when the surface is
        // created; later setScreen() calls are ignored. Losing that output also
        // leaves no mapped surface. Only a new surface reaches the chosen screen.
        // Wait until Qt has finished moving windows off a removed screen.
        if (!remapPending) {
            remapPending = true;
            QTimer::singleShot(0, this, &WindowHost::remapSidebar);
        }
        return;
    }
    const int width = std::min(sidebarWidth, screen->geometry().width());
    if (!sidebar.isVisible()) {
        if (placedScreen != screen) {
            placedScreen = screen;
            emit placementChanged();
        }
        // An initial size until the compositor configures the new surface.
        sidebar.resize(width, screen->availableGeometry().height());
    }
    if (testSurfaces) {
        // Ordinary offscreen surfaces stand in for the compositor's configure:
        // the full height at the right edge of the output chosen at creation.
        const QRect bounds = placedScreen->availableGeometry();
        sidebar.setGeometry(bounds.x() + bounds.width() - width, bounds.y(), width, bounds.height());
        return;
    }
#ifdef COMPANION_LAYER_SHELL
    auto *layer = LayerShellQt::Window::get(&sidebar);
    layer->setScreen(screen);
    layer->setScope("companion-panel");
    layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorTop) | LayerShellQt::Window::AnchorBottom
                      | LayerShellQt::Window::AnchorRight);
    layer->setLayer(mode == "dock" ? LayerShellQt::Window::LayerTop : LayerShellQt::Window::LayerOverlay);
    layer->setExclusiveZone(mode == "dock" ? width : 0);
    layer->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityOnDemand);
    layer->setActivateOnShow(false);
    layer->setCloseOnDismissed(false);
    // Height 0 lets the compositor fill the space between the anchors, minus
    // other exclusive zones. Never resize a configured surface from Qt's screen
    // height: it includes those zones, so the panel would overflow its space.
    layer->setDesiredSize(QSize(width, 0));
    // Layer state is double-buffered until the next surface commit. Request a
    // frame so a changed width or reserved zone applies on an idle panel.
    if (sidebar.isVisible()) sidebar.update();
#endif
}

void WindowHost::remapSidebar() {
    remapPending = false;
    if (mode == "window" || !sidebar.isVisible()) return;
    QScreen *screen = preferredSidebarScreen();
    if (!screen || screen == placedScreen) return;
    // The presentation choice is unchanged; only its native surface is replaced.
    replaceSurface([this] {
        updateSidebar();
    });
}

QSize WindowHost::ordinaryBounds(const QScreen *screen) const {
    // The largest Window that fits the screen's usable area, as far as Qt can
    // tell. Used both before mapping and to decide whether a shown Window must
    // be refitted, so the two never disagree.
    const QSize available = screen->availableGeometry().size();
    return QSize(available.width() - compositorPanelAllowance, available.height() - compositorPanelAllowance)
        .expandedTo(ordinary.minimumSize());
}

void WindowHost::fitOrdinary() {
    // Hyprland centres a newly mapped floating window at the size it requests,
    // so a remembered size larger than the screen leaves the top and bottom
    // controls offscreen. Fit it only before mapping: once mapped, the
    // compositor owns the outer geometry and a Qt resize would mismatch it.
    if (ordinary.isVisible()) return;
    QScreen *screen = ordinary.screen() ? ordinary.screen() : QGuiApplication::primaryScreen();
    if (!screen) return;
    const QSize fitted = ordinary.size().boundedTo(ordinaryBounds(screen));
    if (fitted != ordinary.size()) ordinary.resize(fitted);
}

void WindowHost::resizeBy(int delta) {
    delta = std::clamp(delta, -200, 200);
    if (mode == "window") {
        const auto *screen = ordinary.screen();
        const int maximum = screen ? screen->availableGeometry().width() : 1600;
        ordinary.resize(std::clamp(ordinary.width() + delta, std::min(360, maximum), maximum), ordinary.height());
    } else {
        sidebarWidth = std::clamp(sidebarWidth + delta, 360, 1600);
        settings.setValue("sidebar/width", sidebarWidth);
        updateSidebar();
    }
}

bool WindowHost::eventFilter(QObject *object, QEvent *event) {
    if (object == &sidebar && event->type() == QEvent::PlatformSurface
        && static_cast<QPlatformSurfaceEvent *>(event)->surfaceEventType() == QPlatformSurfaceEvent::SurfaceAboutToBeDestroyed) {
        releaseFocus();
    }
    if ((object == &ordinary || object == &sidebar) && event->type() == QEvent::Close) {
        releaseFocus();
        static_cast<QCloseEvent *>(event)->ignore();
        static_cast<QWindow *>(object)->hide();
        return true;
    }
    return QObject::eventFilter(object, event);
}

void WindowHost::send(QLocalSocket *client, const QJsonObject &message) {
    const auto bytes = QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n';
    if (client->bytesToWrite() + bytes.size() > 256 * 1024) {
        client->abort();
        return;
    }
    client->write(bytes);
}

void WindowHost::publish(const QJsonObject &value) {
    status = value;
    status["type"] = "status";
    status["protocol"] = 1;
    for (auto *client : clients.keys()) send(client, status);
}

void WindowHost::notify(const QJsonObject &event) {
    // Focus/media events belong only to the currently connected desktop bridge.
    if (bridge) send(bridge, event);
}

void WindowHost::accept() {
    while (auto *client = server.nextPendingConnection()) {
        if (clients.size() >= 8) {
            client->abort();
            client->deleteLater();
            continue;
        }
        clients.insert(client, {});
        client->setReadBufferSize(64 * 1024 + 1);
        send(client, status);
        connect(client, &QLocalSocket::disconnected, this, [this, client] {
            clients.remove(client);
            if (bridge == client) {
                bridge.clear();
                emit bridgeChanged();
            }
            client->deleteLater();
        });
        connect(client, &QLocalSocket::readyRead, this, [this, client] {
            clients[client] += client->readAll();
            if (clients[client].size() > 64 * 1024) {
                client->abort();
                return;
            }
            while (true) {
                if (!clients.contains(client)) return;
                auto &buffer = clients[client];
                const auto end = buffer.indexOf('\n');
                if (end < 0) return;
                const auto document = QJsonDocument::fromJson(buffer.left(end));
                buffer.remove(0, end + 1);
                if (!document.isObject()) {
                    client->abort();
                    return;
                }
                const auto message = document.object();
                if (message.value("action") == "bridge") {
                    // One adapter owns focus/media replies. Never deliver them
                    // to a later connection from the launcher command.
                    if (bridge && bridge != client) {
                        client->abort();
                        return;
                    }
                    bridge = client;
                    emit bridgeChanged();
                } else {
                    emit command(message);
                }
                if (!clients.contains(client)) return;
                send(client, {{"type", "ack"}});
            }
        });
    }
}
