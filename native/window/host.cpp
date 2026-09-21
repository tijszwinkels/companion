#include "host.hpp"

#include <QCloseEvent>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QScreen>
#include <algorithm>
#ifdef COMPANION_LAYER_SHELL
#include <LayerShellQt/Window>
#endif

WindowHost::WindowHost(QObject *parent, bool testSurfaces) : QObject(parent), testSurfaces(testSurfaces) {
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
        connect(surface, &QWindow::screenChanged, this, [this] { updateSidebar(); });
    }
    connect(&ordinary, &QWindow::widthChanged, this, [this](int value) {
        if (ordinary.isVisible()) settings.setValue("window/width", value);
    });
    connect(&ordinary, &QWindow::heightChanged, this, [this](int value) {
        if (ordinary.isVisible()) settings.setValue("window/height", value);
    });
    sidebarWidth = std::clamp(settings.value("sidebar/width", 600).toInt(), 360, 1600);
    connect(&server, &QLocalServer::newConnection, this, &WindowHost::accept);
    connect(qGuiApp, &QGuiApplication::screenRemoved, this, [this] { updateSidebar(); });
    for (auto *screen : QGuiApplication::screens()) {
        connect(screen, &QScreen::geometryChanged, this, [this] { updateSidebar(); });
    }
    connect(qGuiApp, &QGuiApplication::screenAdded, this, [this](QScreen *screen) {
        connect(screen, &QScreen::geometryChanged, this, [this] { updateSidebar(); });
        updateSidebar();
    });
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
    updateSidebar();
    window()->show();
    if (focus) activate();
}

void WindowHost::hide() { window()->hide(); }
void WindowHost::activate() { window()->requestActivate(); }

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
    if (value == mode) return;
    const bool visible = opened();
    const bool focused = active();
    QPointer<QQuickItem> focusItem = window()->activeFocusItem();
    changingSurface = true;
    window()->hide();
    mode = value;
    settings.setValue("presentation", mode);
    updateSidebar();
    if (body) body->setParentItem(contentItem());
    emit surfaceChanged();
    setError("");
    if (visible) {
        show(focused);
        if (focusItem) focusItem->forceActiveFocus(Qt::OtherFocusReason);
    }
    changingSurface = false;
    emit stateChanged();
}

void WindowHost::updateSidebar() {
    if (mode == "window" || !sidebarAvailable()) return;
    if (testSurfaces) { sidebar.resize(sidebarWidth, 780); return; }
#ifdef COMPANION_LAYER_SHELL
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
    if (!screen) return;
    const int width = std::min(sidebarWidth, screen->geometry().width());
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
    layer->setDesiredSize(QSize(width, 0));
    sidebar.resize(width, screen->availableGeometry().height());
#endif
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
    if ((object == &ordinary || object == &sidebar) && event->type() == QEvent::Close) {
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
