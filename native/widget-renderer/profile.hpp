#pragma once

#include <QQuickWebEngineProfile>
#include <QUrl>

class QWebEngineUrlSchemeHandler;

// A profile belongs to exactly one widget view. Browser requests never select
// a network destination: the scheme handler maps three fixed paths to this
// trusted, capability-scoped Companion endpoint.
class WidgetProfile : public QQuickWebEngineProfile {
    Q_OBJECT
    Q_PROPERTY(QUrl viewUrl READ viewUrl WRITE setViewUrl NOTIFY viewUrlChanged)
    Q_PROPERTY(QUrl documentUrl READ documentUrl NOTIFY viewUrlChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    explicit WidgetProfile(QObject *parent = nullptr);
    ~WidgetProfile() override;
    QUrl viewUrl() const { return m_viewUrl; }
    QUrl documentUrl() const;
    QString error() const { return m_error; }
    quint64 generation() const { return m_generation; }
    void setViewUrl(const QUrl &url);
    void reportError(const QString &error);

signals:
    void viewUrlChanged();
    void errorChanged();

private:
    QUrl m_viewUrl;
    QString m_error;
    quint64 m_generation = 0;
    QWebEngineUrlSchemeHandler *m_endpoint = nullptr;
};
