#include "initialize.hpp"
#include <QtQuickTest/quicktest.h>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>
#include <QQmlEngine>
#include <cstdio>

class Setup : public QObject {
    Q_OBJECT
public slots:
    void qmlEngineAvailable(QQmlEngine *engine) {
        connect(engine, &QQmlEngine::warnings, engine, [](const QList<QQmlError> &errors) {
            for (const auto &error : errors) {
                fprintf(stderr, "%s\n", qPrintable(error.toString()));
            }
        });
    }
};

int main(int argc, char **argv) {
    registerWidgetScheme();
    QtWebEngineQuick::initialize();
    Setup setup;
    return quick_test_main_with_setup(argc, argv, "CompanionNativeWidgets", nullptr, &setup);
}

#include "test-main.moc"
