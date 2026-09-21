#pragma once

#include <QJsonObject>
#include <QLocalSocket>
#include <QObject>
#include <QTimer>

// Trusted desktop transport. Widget JavaScript never receives this object.
// Reconnects restore snapshots; commands are never replayed after a disconnect.
class DesktopConnection : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool connected READ connected NOTIFY connectedChanged)
public:
    explicit DesktopConnection(const QString &path, QObject *parent = nullptr);
    bool connected() const;
    Q_INVOKABLE bool send(const QJsonObject &message);
    void start();

signals:
    void connectedChanged();
    void received(const QJsonObject &message);
    void disconnected();

private:
    void read();
    void lost();
    QString path;
    QLocalSocket socket;
    QTimer retry;
    QByteArray input;
    bool announced = false;
};
