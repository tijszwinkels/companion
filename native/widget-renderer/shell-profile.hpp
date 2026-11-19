#pragma once

#include <QQuickWebEngineProfile>
#include <QString>
#include <QUrl>

class QWebEngineUrlSchemeHandler;

// The browser profile of one TRUSTED Companion HTML surface: the default
// session chat or the session rail. These pages are Companion's own code,
// built from integrations/session-apps/ and loaded from a fixed local bundle
// directory. They talk to the native host only through the QWebChannel object
// that their QML view registers; this profile gives them no network, file or
// capability URL access.
//
// Agent-authored session applications never load here. They keep the separate
// restricted WidgetProfile, which has no QWebChannel and brokers only their
// own capability-scoped state/query/action endpoints.
//
// Inputs (set once from QML, before the document loads):
// - `surface`: "chat" or "rail"; selects `<surface>.html` as the document.
// - `bundleDirectory`: absolute local directory containing the built pages.
// Output: `documentUrl`, empty until both are valid.
class ShellProfile : public QQuickWebEngineProfile {
    Q_OBJECT
    Q_PROPERTY(QString surface READ surface WRITE setSurface NOTIFY documentUrlChanged)
    Q_PROPERTY(QString bundleDirectory READ bundleDirectory WRITE setBundleDirectory NOTIFY documentUrlChanged)
    Q_PROPERTY(QUrl documentUrl READ documentUrl NOTIFY documentUrlChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    explicit ShellProfile(QObject *parent = nullptr);
    ~ShellProfile() override;

    QString surface() const { return m_surface; }
    QString bundleDirectory() const { return m_bundleDirectory; }
    QUrl documentUrl() const;
    QString error() const { return m_error; }

    void setSurface(const QString &surface);
    void setBundleDirectory(const QString &directory);
    void reportError(const QString &error);

    // The file a request path names inside the bundle, or an empty string
    // when the path is not one of the fixed page/asset names.
    QString resolve(const QString &path) const;

signals:
    void documentUrlChanged();
    void errorChanged();

private:
    QString m_surface;
    QString m_bundleDirectory;
    QString m_error;
    QWebEngineUrlSchemeHandler *m_endpoint = nullptr;
};
