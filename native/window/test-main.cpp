#include "host.hpp"
#include "../widget-renderer/initialize.hpp"
#include <QQmlContext>
#include <QQmlEngine>
#include <QtQuickTest/quicktest.h>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <memory>

class Setup : public QObject {
    Q_OBJECT
    std::unique_ptr<WindowHost> host;
public slots:
    void qmlEngineAvailable(QQmlEngine *engine) {
        host = std::make_unique<WindowHost>(nullptr, true);
        engine->rootContext()->setContextProperty("TestHost", host.get());
        engine->rootContext()->setContextProperty("CompanionRenderDiagnostics", qEnvironmentVariableIsSet("COMPANION_TEST_RENDER_DIAGNOSTICS"));
    }
};

int main(int argc, char **argv) {
    registerWidgetScheme();
    QtWebEngineQuick::initialize();
    Setup setup;
    return quick_test_main_with_setup(argc, argv, "CompanionWindow", nullptr, &setup);
}
#include "test-main.moc"
