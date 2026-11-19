#include "host.hpp"
#include "rendering.hpp"
#include "../widget-renderer/initialize.hpp"
#include <QClipboard>
#include <QGuiApplication>
#include <QMimeData>
#include <QJsonArray>
#include <QJsonObject>
#include <QQmlContext>
#include <QQmlEngine>
#include <qpa/qplatformnativeinterface.h>
#include <qpa/qwindowsysteminterface.h>
#include <QtQuickTest/quicktest.h>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <memory>

// Replaces the offscreen platform's monitors, as a compositor would on hotplug,
// resize or scale changes. Screens are matched by name: absent names are
// removed, new names added and changed geometry reported for the others.
class TestScreens : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE bool configure(const QVariantList &screens) {
        using Configure = void (*)(const QJsonObject &, QPlatformNativeInterface *);
        auto *native = QGuiApplication::platformNativeInterface();
        auto configure = native ? reinterpret_cast<Configure>(native->nativeResourceForIntegration("setConfiguration")) : nullptr;
        if (!configure) return false;
        configure({{"screens", QJsonArray::fromVariantList(screens)}}, native);
        // Deliver the queued screen events now, so each call is one completed change.
        QWindowSystemInterface::flushWindowSystemEvents();
        return true;
    }
};

// Reads this test process's own clipboard as the native plain-text export
// (the text/plain MIME bytes another application would receive), not the
// QString a QML TextEdit would paste. Offscreen Qt keeps the clipboard in
// this process; the desktop clipboard is never involved.
class TestClipboard : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE int plainTextBytes() const {
        const QMimeData *data = QGuiApplication::clipboard()->mimeData();
        return data ? int(data->data("text/plain").size()) : -1;
    }
    Q_INVOKABLE bool plainTextEquals(const QString &expected) const {
        const QMimeData *data = QGuiApplication::clipboard()->mimeData();
        return data && data->data("text/plain") == expected.toUtf8();
    }
    // The exported bytes, decoded as UTF-8, so a test can compare them with
    // the source text it expects (a dropped character shows as a mismatch).
    Q_INVOKABLE QString plainTextDecoded() const {
        const QMimeData *data = QGuiApplication::clipboard()->mimeData();
        return data ? QString::fromUtf8(data->data("text/plain")) : QString();
    }
};

class Setup : public QObject {
    Q_OBJECT
    std::unique_ptr<WindowHost> host;
    TestScreens screens;
    TestClipboard clipboard;
    WidgetRendering widgetRendering;
public slots:
    void qmlEngineAvailable(QQmlEngine *engine) {
        host = std::make_unique<WindowHost>(nullptr, true);
        engine->rootContext()->setContextProperty("TestHost", host.get());
        engine->rootContext()->setContextProperty("TestScreens", &screens);
        engine->rootContext()->setContextProperty("TestClipboard", &clipboard);
        engine->rootContext()->setContextProperty("CompanionRenderDiagnostics", qEnvironmentVariableIsSet("COMPANION_TEST_RENDER_DIAGNOSTICS"));
        widgetRendering.setMode(qEnvironmentVariable("COMPANION_TEST_WIDGET_RENDERING", widgetRendering.mode()));
        engine->rootContext()->setContextProperty("CompanionWidgetRendering", &widgetRendering);
        // Existing suites exercise the classic QML view; HTML surface tests opt in.
        engine->rootContext()->setContextProperty("CompanionSessionSurface",
            qEnvironmentVariable("COMPANION_TEST_SESSION_SURFACE", "classic"));
    }
};

int main(int argc, char **argv) {
    registerWidgetScheme();
    QtWebEngineQuick::initialize();
    Setup setup;
    return quick_test_main_with_setup(argc, argv, "CompanionWindow", nullptr, &setup);
}
#include "test-main.moc"
