#include "connection.hpp"

#include <QJsonDocument>

namespace {
constexpr qint64 maximumSnapshot = 16 * 1024 * 1024;
constexpr qint64 maximumCommands = 1024 * 1024;
}

DesktopConnection::DesktopConnection(const QString &path, QObject *parent)
    : QObject(parent), path(path) {
    retry.setInterval(1000);
    retry.setSingleShot(true);
    socket.setReadBufferSize(maximumSnapshot + 1);
    connect(&retry, &QTimer::timeout, this, &DesktopConnection::start);
    connect(&socket, &QLocalSocket::connected, this, [this] {
        announced = true;
        retry.stop();
        emit connectedChanged();
    });
    connect(&socket, &QLocalSocket::readyRead, this, &DesktopConnection::read);
    connect(&socket, &QLocalSocket::disconnected, this, &DesktopConnection::lost);
    connect(&socket, &QLocalSocket::errorOccurred, this, [this] { lost(); });
}

bool DesktopConnection::connected() const {
    return socket.state() == QLocalSocket::ConnectedState;
}

void DesktopConnection::start() {
    if (socket.state() == QLocalSocket::UnconnectedState) {
        socket.connectToServer(path);
    }
}

bool DesktopConnection::send(const QJsonObject &message) {
    const auto bytes = QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n';
    if (!connected() || socket.bytesToWrite() + bytes.size() > maximumCommands) {
        return false;
    }
    return socket.write(bytes) == bytes.size();
}

void DesktopConnection::lost() {
    input.clear();
    socket.abort();
    if (announced) {
        announced = false;
        emit connectedChanged();
        emit disconnected();
    }
    retry.start();
}

void DesktopConnection::read() {
    input += socket.readAll();
    while (true) {
        const auto end = input.indexOf('\n');
        if (end < 0) {
            if (input.size() > maximumSnapshot) lost();
            return;
        }
        if (end > maximumSnapshot) {
            lost();
            return;
        }
        QJsonParseError error;
        const auto document = QJsonDocument::fromJson(input.left(end), &error);
        input.remove(0, end + 1);
        if (error.error != QJsonParseError::NoError || !document.isObject()) {
            lost();
            return;
        }
        emit received(document.object());
    }
}
