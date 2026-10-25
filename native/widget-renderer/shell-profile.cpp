#include "shell-profile.hpp"

#include <QBuffer>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QQuickWebEngineDownloadRequest>
#include <QRegularExpression>
#include <QWebEngineCookieStore>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineUrlRequestJob>
#include <QWebEngineUrlSchemeHandler>

namespace {
// Built pages are a few hundred kilobytes; this only bounds a broken build.
constexpr qint64 maximumFile = 4 * 1024 * 1024;

// QtWebEngine ships the QWebChannel client in its own resources. Serving it
// from the trusted scheme avoids allowing qrc: (a local scheme) in the page.
const QString webChannelScript = QStringLiteral(":/qtwebchannel/qwebchannel.js");

bool validSurface(const QString &surface) {
    return surface == "chat" || surface == "rail";
}

// Every request names this profile's own surface host. Pages, scripts,
// styles and embedded images/fonts are the only resource types accepted.
class Requests : public QWebEngineUrlRequestInterceptor {
public:
    explicit Requests(ShellProfile *profile)
        : QWebEngineUrlRequestInterceptor(profile), profile(profile) {}

    void interceptRequest(QWebEngineUrlRequestInfo &request) override {
        const QUrl url = request.requestUrl();
        const auto type = request.resourceType();

        const bool own = url.scheme() == "companion-shell" && url.host() == profile->surface()
            && url.userInfo().isEmpty() && url.port() == -1 && !url.hasQuery()
            && !url.hasFragment() && !profile->resolve(url.path()).isEmpty();
        const bool ownType = type == QWebEngineUrlRequestInfo::ResourceTypeMainFrame
            || type == QWebEngineUrlRequestInfo::ResourceTypeScript
            || type == QWebEngineUrlRequestInfo::ResourceTypeStylesheet;
        const bool inlineAsset = url.scheme() == "data"
            && (type == QWebEngineUrlRequestInfo::ResourceTypeImage
                || type == QWebEngineUrlRequestInfo::ResourceTypeFontResource);

        request.block(!((own && ownType) || inlineAsset));
    }

private:
    ShellProfile *profile;
};

// Serves the fixed bundle files synchronously. There is no network access
// and no path chosen by the page beyond the fixed name pattern.
class Endpoint : public QWebEngineUrlSchemeHandler {
public:
    explicit Endpoint(ShellProfile *profile) : QWebEngineUrlSchemeHandler(profile), profile(profile) {}

    void requestStarted(QWebEngineUrlRequestJob *job) override {
        const QUrl url = job->requestUrl();

        if (job->requestMethod() != "GET" || url.host() != profile->surface()
            || !url.userInfo().isEmpty() || url.port() != -1 || url.hasQuery() || url.hasFragment()) {
            job->fail(QWebEngineUrlRequestJob::RequestDenied);
            return;
        }

        const QString file = profile->resolve(url.path());
        if (file.isEmpty()) {
            job->fail(QWebEngineUrlRequestJob::UrlNotFound);
            return;
        }

        QFile input(file);
        if (!input.open(QIODevice::ReadOnly) || input.size() > maximumFile) {
            profile->reportError("Could not load the Companion chat page");
            job->fail(QWebEngineUrlRequestJob::RequestFailed);
            return;
        }

        auto *buffer = new QBuffer(job);
        buffer->setData(input.read(maximumFile));
        buffer->open(QIODevice::ReadOnly);

        QByteArray type = "application/octet-stream";
        if (file.endsWith(".html")) {
            type = "text/html";
        } else if (file.endsWith(".js")) {
            type = "text/javascript";
        } else if (file.endsWith(".css")) {
            type = "text/css";
        }
        job->reply(type, buffer);
    }

private:
    ShellProfile *profile;
};
}

ShellProfile::ShellProfile(QObject *parent) : QQuickWebEngineProfile(parent) {
    setOffTheRecord(true);
    setHttpCacheType(MemoryHttpCache);
    setPersistentCookiesPolicy(NoPersistentCookies);
    setPersistentPermissionsPolicy(PersistentPermissionsPolicy::AskEveryTime);
    cookieStore()->setCookieFilter([](const QWebEngineCookieStore::FilterRequest &) { return false; });
    setUrlRequestInterceptor(new Requests(this));

    m_endpoint = new Endpoint(this);
    installUrlSchemeHandler("companion-shell", m_endpoint);

    connect(this, &QQuickWebEngineProfile::downloadRequested, this,
            [](QQuickWebEngineDownloadRequest *download) { download->cancel(); });
}

ShellProfile::~ShellProfile() {
    // Same teardown order as WidgetProfile: retire the handler while this
    // derived profile's members still exist.
    removeUrlSchemeHandler(m_endpoint);
    delete m_endpoint;
}

QUrl ShellProfile::documentUrl() const {
    if (m_surface.isEmpty() || m_bundleDirectory.isEmpty()) {
        return QUrl();
    }
    return QUrl("companion-shell://" + m_surface + "/");
}

// Both inputs are accepted once. A trusted page never changes identity or
// origin directory while it runs; replacing them would need a new view.
void ShellProfile::setSurface(const QString &surface) {
    if (!m_surface.isEmpty() || !validSurface(surface)) {
        return;
    }
    m_surface = surface;
    emit documentUrlChanged();
}

void ShellProfile::setBundleDirectory(const QString &directory) {
    if (!m_bundleDirectory.isEmpty() || directory.isEmpty()) {
        return;
    }

    const QFileInfo info(directory);
    if (!info.isAbsolute() || !info.isDir()) {
        reportError("The Companion chat page has not been built");
        return;
    }

    m_bundleDirectory = info.canonicalFilePath();
    emit documentUrlChanged();
}

void ShellProfile::reportError(const QString &error) {
    if (m_error != error) {
        m_error = error;
        emit errorChanged();
    }
}

QString ShellProfile::resolve(const QString &path) const {
    static const QRegularExpression asset("^/([a-z0-9-]+\\.(js|css))$");

    if (m_bundleDirectory.isEmpty() || !validSurface(m_surface)) {
        return QString();
    }

    if (path == "/") {
        const QString document = m_bundleDirectory + "/" + m_surface + ".html";
        return QFileInfo(document).isFile() ? document : QString();
    }

    if (path == "/qwebchannel.js") {
        return webChannelScript;
    }

    const auto match = asset.match(path);
    if (!match.hasMatch()) {
        return QString();
    }

    // Names cannot contain separators, so the file is directly inside the
    // bundle directory. A symbolic link leaving it is still refused.
    const QFileInfo file(m_bundleDirectory + "/" + match.captured(1));
    if (!file.isFile() || QFileInfo(file.canonicalFilePath()).absolutePath() != m_bundleDirectory) {
        return QString();
    }
    return file.canonicalFilePath();
}
