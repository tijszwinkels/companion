#include "host.hpp"
#include "rendering.hpp"
#include "../widget-renderer/initialize.hpp"
#include <QGuiApplication>
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

class Setup : public QObject {
    Q_OBJECT
    std::unique_ptr<WindowHost> host;
    TestScreens screens;
    WidgetRendering widgetRendering;
public slots:
    void qmlEngineAvailable(QQmlEngine *engine) {
        host = std::make_unique<WindowHost>(nullptr, true);
        engine->rootContext()->setContextProperty("TestHost", host.get());
        engine->rootContext()->setContextProperty("TestScreens", &screens);
        engine->rootContext()->setContextProperty("CompanionRenderDiagnostics", qEnvironmentVariableIsSet("COMPANION_TEST_RENDER_DIAGNOSTICS"));
        widgetRendering.setMode(qEnvironmentVariable("COMPANION_TEST_WIDGET_RENDERING", widgetRendering.mode()));
        engine->rootContext()->setContextProperty("CompanionWidgetRendering", &widgetRendering);
    }
};

int main(int argc, char **argv) {
    registerWidgetScheme();
    QtWebEngineQuick::initialize();
    Setup setup;
    return quick_test_main_with_setup(argc, argv, "CompanionWindow", nullptr, &setup);
}
#include "test-main.moc"
