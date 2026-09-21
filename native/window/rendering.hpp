#pragma once

#include <QObject>
#include <QString>

// Process-local rendering preference, shared by the trusted QML host and its
// native views. It is never exposed to widget JavaScript or saved in a session.
class WidgetRendering : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString mode READ mode WRITE setMode NOTIFY changed)
    Q_PROPERTY(int renderScale READ renderScale NOTIFY changed)
    Q_PROPERTY(bool filtered READ filtered NOTIFY changed)
public:
    explicit WidgetRendering(QObject *parent = nullptr) : QObject(parent) {}

    static bool accepts(const QString &mode) {
        return mode == "normal" || mode == "supersampled" || mode == "filtered";
    }

    QString mode() const { return currentMode; }
    int renderScale() const { return currentMode == "normal" ? 1 : 2; }
    bool filtered() const { return currentMode == "filtered"; }

    void setMode(const QString &mode) {
        if (!accepts(mode) || mode == currentMode) return;
        currentMode = mode;
        emit changed();
    }

signals:
    void changed();

private:
    QString currentMode = "filtered";
};
