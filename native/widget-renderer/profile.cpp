#include "profile.hpp"

#include <QBuffer>
#include <QNetworkAccessManager>
#include <QNetworkProxy>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QWebEngineCookieStore>
#include <QQuickWebEngineDownloadRequest>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineUrlRequestJob>
#include <QWebEngineUrlSchemeHandler>

namespace {
constexpr qsizetype maximumBody = 160 * 1024;
constexpr qsizetype maximumReply = 4 * 1024 * 1024;

class Requests : public QWebEngineUrlRequestInterceptor {
public:
    explicit Requests(QObject *parent) : QWebEngineUrlRequestInterceptor(parent) {}

    void interceptRequest(QWebEngineUrlRequestInfo &request) override {
        const QUrl url = request.requestUrl();
        const auto type = request.resourceType();
        const bool document = url == QUrl("companion-widget://view/")
            && type == QWebEngineUrlRequestInfo::ResourceTypeMainFrame;
        const bool api = type == QWebEngineUrlRequestInfo::ResourceTypeXhr
            && url.scheme() == "companion-widget" && url.host() == "view"
            && url.userInfo().isEmpty() && url.port() == -1 && !url.hasQuery()
            && !url.hasFragment() && (url.path() == "/state" || url.path() == "/action");
        const bool inlineAsset = url.scheme() == "data"
            && (type == QWebEngineUrlRequestInfo::ResourceTypeScript
                || type == QWebEngineUrlRequestInfo::ResourceTypeImage
                || type == QWebEngineUrlRequestInfo::ResourceTypeFontResource);
        const bool frame = url == QUrl("about:srcdoc")
            && type == QWebEngineUrlRequestInfo::ResourceTypeSubFrame;
        request.block(!(document || api || inlineAsset || frame));
    }
};

class Endpoint : public QWebEngineUrlSchemeHandler {
public:
    explicit Endpoint(WidgetProfile *profile)
        : QWebEngineUrlSchemeHandler(profile), profile(profile), network(this) {
        // This is the trusted local broker, not a browser networking surface.
        network.setProxy(QNetworkProxy::NoProxy);
    }

    ~Endpoint() override {
        // A profile may be destroyed with requests in flight. Disconnect the
        // completion callbacks before member teardown; none may touch QML or
        // the partially destroyed profile during network cleanup.
        for (auto *reply : network.findChildren<QNetworkReply *>()) {
            reply->disconnect();
            reply->abort();
        }
    }

    void requestStarted(QWebEngineUrlRequestJob *job) override {
        const QUrl source = profile->viewUrl();
        const quint64 generation = profile->generation();
        const QUrl url = job->requestUrl();
        const QByteArray method = job->requestMethod();
        const QString path = url.path();
        if (source.isEmpty() || url.host() != "view" || !url.userInfo().isEmpty()
            || url.port() != -1 || url.hasQuery() || url.hasFragment()
            || !((method == "GET" && (path == "/" || path == "/state"))
                || (method == "POST" && path == "/action"))) {
            job->fail(QWebEngineUrlRequestJob::RequestDenied);
            return;
        }

        QByteArray body;
        if (method == "POST") {
            auto *input = job->requestBody();
            if (!input || (!input->isOpen() && !input->open(QIODevice::ReadOnly))) {
                job->fail(QWebEngineUrlRequestJob::RequestDenied);
                return;
            }
            body = input->read(maximumBody + 1);
            if (body.size() > maximumBody || !input->atEnd()) {
                job->fail(QWebEngineUrlRequestJob::RequestDenied);
                return;
            }
        }
        QUrl destination = source;
        if (path != "/") {
            destination.setPath(source.path() + path);
        }
        QNetworkRequest request(destination);
        request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                             QNetworkRequest::ManualRedirectPolicy);
        request.setTransferTimeout(10000);
        request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        auto *reply = method == "GET" ? network.get(request) : network.post(request, body);
        reply->setReadBufferSize(maximumReply + 1);
        auto *buffer = new QBuffer(job);
        buffer->open(QIODevice::ReadWrite);

        // Every operation retains its original endpoint. Changing/revoking a
        // view aborts its outstanding work rather than targeting a successor.
        connect(profile, &WidgetProfile::viewUrlChanged, reply, &QNetworkReply::abort);
        connect(job, &QObject::destroyed, reply, [reply, job] {
            // QObject emits destroyed before disconnecting its signals. Abort
            // synchronously emits finished, so disconnect our job callbacks
            // first: its WebEngine subclass has already been torn down.
            reply->disconnect(job);
            reply->abort();
        });
        connect(reply, &QNetworkReply::readyRead, job, [reply, buffer] {
            buffer->write(reply->read(maximumReply + 1 - buffer->size()));
            if (buffer->size() > maximumReply) {
                reply->abort();
            }
        });
        connect(reply, &QNetworkReply::finished, job, [this, reply, buffer, job, generation, path] {
            const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            if (generation != profile->generation() || reply->error() != QNetworkReply::NoError
                || status != 200 || buffer->size() > maximumReply) {
                if (generation == profile->generation()) {
                    profile->reportError(status == 404 ? "Widget view expired"
                                                      : "Could not load widget data");
                }
                job->fail(QWebEngineUrlRequestJob::RequestFailed);
                return;
            }
            buffer->seek(0);
            job->reply(path == "/" ? "text/html" : "application/json", buffer);
        });
        connect(reply, &QNetworkReply::finished, reply, &QObject::deleteLater);
    }

private:
    WidgetProfile *profile;
    QNetworkAccessManager network;
};
}

WidgetProfile::WidgetProfile(QObject *parent) : QQuickWebEngineProfile(parent) {
    setOffTheRecord(true);
    setHttpCacheType(MemoryHttpCache);
    setPersistentCookiesPolicy(NoPersistentCookies);
    setPersistentPermissionsPolicy(PersistentPermissionsPolicy::AskEveryTime);
    cookieStore()->setCookieFilter([](const QWebEngineCookieStore::FilterRequest &) { return false; });
    setUrlRequestInterceptor(new Requests(this));
    m_endpoint = new Endpoint(this);
    installUrlSchemeHandler("companion-widget", m_endpoint);
    connect(this, &QQuickWebEngineProfile::downloadRequested, this,
            [](QQuickWebEngineDownloadRequest *download) { download->cancel(); });
}

WidgetProfile::~WidgetProfile() {
    // WebEngine's base-profile teardown can dispatch queued scheme requests.
    // Retire the broker now, while this derived profile's URL/generation still
    // exist. QObject child cleanup happens after our members are destroyed and
    // is too late for a handler that reads them. Endpoint also disconnects and
    // aborts its network replies before its own members are torn down.
    removeUrlSchemeHandler(m_endpoint);
    delete m_endpoint;
}

QUrl WidgetProfile::documentUrl() const {
    return m_viewUrl.isEmpty() ? QUrl() : QUrl("companion-widget://view/");
}

void WidgetProfile::setViewUrl(const QUrl &url) {
    static const QRegularExpression valid("^http://127\\.0\\.0\\.1:[0-9]+/view/[0-9a-f]{64}$");
    const QUrl next = valid.match(url.toString()).hasMatch() ? url : QUrl();
    if (next == m_viewUrl) {
        return;
    }
    m_viewUrl = next;
    m_generation++;
    reportError("");
    emit viewUrlChanged();
}

void WidgetProfile::reportError(const QString &error) {
    if (m_error != error) {
        m_error = error;
        emit errorChanged();
    }
}
