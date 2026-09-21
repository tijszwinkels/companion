#include "profile.hpp"
#include <QQmlExtensionPlugin>
#include <QtQml/qqml.h>

class CompanionWidgetsPlugin : public QQmlExtensionPlugin {
    Q_OBJECT
    Q_PLUGIN_METADATA(IID QQmlExtensionInterface_iid)
public:
    void registerTypes(const char *uri) override {
        qmlRegisterType<WidgetProfile>(uri, 1, 0, "WidgetProfile");
    }
};

#include "plugin.moc"
