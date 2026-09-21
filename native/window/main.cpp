#include "connection.hpp"
#include "host.hpp"
#include "rendering.hpp"
#include "../widget-renderer/initialize.hpp"

#include <QCommandLineParser>
#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJSValue>
#include <QLockFile>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QScreen>
#include <QSGRendererInterface>
#include <QTimer>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <cstdio>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    // Qt can send piped output to journald. Keep an explicitly requested trace
    // in this process's terminal even when the user captures it with tee.
    for (int index = 1; index < argc; ++index) {
        if (qstrcmp(argv[index], "--render-diagnostics") == 0) {
            qputenv("QT_FORCE_STDERR_LOGGING", "1");
        }
    }
    if (qEnvironmentVariableIsSet("QTWEBENGINE_DISABLE_SANDBOX")
        || qEnvironmentVariable("QTWEBENGINE_CHROMIUM_FLAGS").contains("--no-sandbox")
        || qEnvironmentVariable("QTWEBENGINE_CHROMIUM_FLAGS").contains("--disable-web-security")) {
        fprintf(stderr, "Companion widgets require Chromium sandboxing and web security.\n");
        return 1;
    }
    registerWidgetScheme();
    QtWebEngineQuick::initialize();
    QGuiApplication app(argc, argv);
    app.setOrganizationName("Companion");
    app.setApplicationName("Companion");
    app.setDesktopFileName("companion");
    app.setQuitOnLastWindowClosed(false);

    WidgetRendering widgetRendering;
    QCommandLineParser parser;
    parser.setApplicationDescription("Companion conversation window");
    parser.addHelpOption();
    parser.addOption({"socket", "Backend socket path", "path"});
    parser.addOption({"control-socket", "UI control socket path", "path"});
    parser.addOption({"presentation", "window, sidebar or dock", "mode"});
    parser.addOption({"command", "Send show, hide, toggle or focus to the running UI", "action"});
    parser.addOption({"hidden", "Start hidden until summoned or a conversation arrives"});
    parser.addOption({"render-diagnostics", "Log window, theme and widget rendering metrics when they change"});
    parser.addOption({"widget-rendering", "Initial widget rendering: normal, supersampled or filtered", "mode", widgetRendering.mode()});
    parser.process(app);

    const auto presentation = parser.value("presentation");
    if (parser.isSet("presentation") && presentation != "window"
        && presentation != "sidebar" && presentation != "dock") {
        fprintf(stderr, "Choose window, sidebar or dock for --presentation.\n");
        return 1;
    }
    // Each invocation sends one operation. Reject ambiguous combinations before
    // contacting a running UI instead of silently dropping its show/hide command.
    if (parser.isSet("presentation") && parser.isSet("command")) {
        fprintf(stderr, "Use --presentation and --command in separate invocations.\n");
        return 1;
    }
    if (!WidgetRendering::accepts(parser.value("widget-rendering"))) {
        fprintf(stderr, "Choose normal, supersampled or filtered for --widget-rendering.\n");
        return 1;
    }
    widgetRendering.setMode(parser.value("widget-rendering"));

    const auto runtime = qEnvironmentVariable("XDG_RUNTIME_DIR");
    if (runtime.isEmpty()) {
        fprintf(stderr, "XDG_RUNTIME_DIR is required.\n");
        return 1;
    }
    const auto directory = runtime + "/companion";
    const mode_t oldMask = umask(0077);
    QDir().mkpath(directory);
    umask(oldMask);
    struct stat metadata {};
    if (lstat(qPrintable(directory), &metadata) != 0 || !S_ISDIR(metadata.st_mode)
        || metadata.st_uid != getuid() || (metadata.st_mode & 0077)) {
        fprintf(stderr, "Companion runtime directory must be private and owned by this user.\n");
        return 1;
    }
    const auto control = parser.isSet("control-socket") ? parser.value("control-socket") : directory + "/ui.sock";
    const auto backend = parser.isSet("socket") ? parser.value("socket") : directory + "/control.sock";
    const auto action = parser.value("command");
    if (!action.isEmpty() && action != "show" && action != "hide" && action != "toggle" && action != "focus") {
        fprintf(stderr, "Unknown UI command.\n");
        return 1;
    }
    QLocalSocket existing;
    existing.connectToServer(control);
    if (existing.waitForConnected(200)) {
        if (parser.isSet("render-diagnostics")) {
            fprintf(stderr, "Stop the existing UI process before starting with --render-diagnostics.\n");
            return 1;
        }
        if (parser.isSet("widget-rendering")) {
            fprintf(stderr, "Use the running UI's rendering controls, or stop it before starting with --widget-rendering.\n");
            return 1;
        }
        QJsonObject request{{"action", action.isEmpty() ? "show" : action}, {"activate", true}};
        if (parser.isSet("presentation")) request = {{"action", "presentation"}, {"mode", presentation}};
        existing.write(QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n');
        if (!existing.waitForBytesWritten(1000)) return 1;
        QByteArray response;
        while (existing.waitForReadyRead(1000)) {
            response += existing.readAll();
            if (response.contains("\"type\":\"ack\"")) return 0;
            if (response.size() > 65536) break;
        }
        fprintf(stderr, "Running Companion UI did not acknowledge the command.\n");
        return 1;
    }
    if (!action.isEmpty()) {
        fprintf(stderr, "Companion UI is not running.\n");
        return 1;
    }

    // Only the lock owner may remove a stale socket. It spans the whole host
    // lifetime, so concurrent launchers cannot unlink a newly listening host.
    QLockFile lock(control + ".lock");
    lock.setStaleLockTime(0);
    if (!lock.tryLock(0)) {
        fprintf(stderr, "Companion UI is already starting.\n");
        return 1;
    }
    QLocalServer::removeServer(control);
    WindowHost host;
    DesktopConnection connection(backend);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("WindowHost", &host);
    engine.rootContext()->setContextProperty("DesktopConnection", &connection);
    engine.rootContext()->setContextProperty("CompanionRenderDiagnostics", parser.isSet("render-diagnostics"));
    engine.rootContext()->setContextProperty("CompanionWidgetRendering", &widgetRendering);
    engine.addImportPath(QCoreApplication::applicationDirPath() + "/qml");
    engine.addImportPath(QCoreApplication::applicationDirPath() + "/../lib/companion/qml");
    const auto installed = QCoreApplication::applicationDirPath() + "/../share/companion/integrations/window/Main.qml";
    const auto source = QFileInfo::exists(installed) ? installed : QStringLiteral(COMPANION_UI_SOURCE);
    engine.load(QUrl::fromLocalFile(source));
    if (engine.rootObjects().isEmpty()) return 1;
    auto *body = qobject_cast<QQuickItem *>(engine.rootObjects().first());
    if (!body || !host.listen(control)) return 1;
    host.attach(body);
    QSettings settings;
    host.setPresentation(parser.isSet("presentation") ? presentation
                                                    : settings.value("presentation", "window").toString());
    if (!parser.isSet("hidden")) host.show(false);
    connection.start();

    // Opt-in, read-only sampling on the GUI thread. A short startup trace can
    // distinguish late theme changes from a window/Chromium density mismatch.
    // Log only rendering metadata, never session text, widget props or URLs.
    // The timer dies before the engine/body when the event loop exits.
    QTimer diagnostics;
    QByteArray previousMetrics;
    if (parser.isSet("render-diagnostics")) {
        QObject::connect(&diagnostics, &QTimer::timeout, &app, [&] {
            auto *window = body->window();
            if (!window) return;
            auto *screen = window->screen();
            auto *renderer = window->rendererInterface();
            const auto theme = body->property("theme").value<QJSValue>().toVariant().toMap();
            QJsonObject metrics{
                {"kind", "window"}, {"presentation", host.presentation()},
                {"visible", window->isVisible()}, {"platform", QGuiApplication::platformName()},
                {"x", window->x()}, {"y", window->y()},
                {"width", window->width()}, {"height", window->height()},
                {"windowDpr", window->devicePixelRatio()},
                {"effectiveDpr", window->effectiveDevicePixelRatio()},
                {"sceneGraphReady", window->isSceneGraphInitialized()},
                {"screen", screen ? screen->name() : QString()},
                {"screenDpr", screen ? screen->devicePixelRatio() : 0},
                {"graphicsApi", renderer ? int(renderer->graphicsApi()) : 0},
                {"widgetRendering", widgetRendering.mode()},
                {"themeUnit", theme.value("unit").toDouble()},
                {"themeBackground", theme.value("background").toString()},
                {"themeForeground", theme.value("foreground").toString()},
                {"fontFamily", theme.value("fontFamily").toString()}
            };
            const auto encoded = QJsonDocument(metrics).toJson(QJsonDocument::Compact);
            if (encoded == previousMetrics) return;
            previousMetrics = encoded;
            metrics["timeMs"] = QDateTime::currentMSecsSinceEpoch();
            qInfo().noquote() << "COMPANION_RENDER" << QJsonDocument(metrics).toJson(QJsonDocument::Compact);
        });
        diagnostics.start(100);
    }
    return app.exec();
}
