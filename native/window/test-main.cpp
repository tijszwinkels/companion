#include "host.hpp"
#include "rendering.hpp"
#include "../widget-renderer/initialize.hpp"
#include <QQmlContext>
#include <QQmlEngine>
#include <QtQuickTest/quicktest.h>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <memory>

class Setup : public QObject {
    Q_OBJECT
    std::unique_ptr<WindowHost> host;
    WidgetRendering widgetRendering;
public slots:
    void qmlEngineAvailable(QQmlEngine *engine) {
        host = std::make_unique<WindowHost>(nullptr, true);
        engine->rootContext()->setContextProperty("TestHost", host.get());
        engine->rootContext()->setContextProperty("CompanionRenderDiagnostics", qEnvironmentVariableIsSet("COMPANION_TEST_RENDER_DIAGNOSTICS"));
        widgetRendering.setMode(qEnvironmentVariable("COMPANION_TEST_WIDGET_RENDERING", "normal"));
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
