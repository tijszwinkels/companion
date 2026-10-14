#pragma once

#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QSettings>
#include <QTimer>
#include <functional>
#include "layer-focus.hpp"

// Owns two native surfaces and one persistent QML body. Reparenting the body
// preserves tab state, text selection, composer drafts and browser documents.
class WindowHost : public QObject {
    Q_OBJECT
    Q_PROPERTY(QQuickItem *contentItem READ contentItem NOTIFY surfaceChanged)
    Q_PROPERTY(bool opened READ opened NOTIFY stateChanged)
    Q_PROPERTY(bool active READ active NOTIFY stateChanged)
    Q_PROPERTY(QString presentation READ presentation NOTIFY surfaceChanged)
    Q_PROPERTY(bool sidebarAvailable READ sidebarAvailable CONSTANT)
    Q_PROPERTY(bool bridgeConnected READ bridgeConnected NOTIFY bridgeChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)
    Q_PROPERTY(bool switching READ switching NOTIFY stateChanged)
    // Output that the current or next Sidebar/Dock surface is placed on.
    Q_PROPERTY(QString sidebarScreen READ sidebarScreen NOTIFY placementChanged)
public:
    explicit WindowHost(QObject *parent = nullptr, bool testSurfaces = false);
    ~WindowHost() override;
    QQuickItem *contentItem() const;
    bool opened() const;
    bool active() const;
    QString presentation() const;
    bool sidebarAvailable() const;
    bool bridgeConnected() const;
    QString error() const { return failure; }
    bool switching() const { return changingSurface; }
    QString sidebarScreen() const;
    bool listen(const QString &path);
    Q_INVOKABLE void attach(QQuickItem *body);
    Q_INVOKABLE void show(bool activate = false);
    Q_INVOKABLE void hide();
    Q_INVOKABLE void activate();
    Q_INVOKABLE void releaseFocus();
    Q_INVOKABLE void setPresentation(const QString &mode);
    Q_INVOKABLE void resizeBy(int logicalPixels);
    Q_INVOKABLE void publish(const QJsonObject &status);
    Q_INVOKABLE void notify(const QJsonObject &event);

signals:
    void stateChanged();
    void surfaceChanged();
    void bridgeChanged();
    void errorChanged();
    void command(const QJsonObject &message);
    void focusCleared();
    void placementChanged();

protected:
    bool eventFilter(QObject *object, QEvent *event) override;

private:
    QQuickWindow *window() const;
    QScreen *preferredSidebarScreen() const;
    void screensChanged();
    void refitVisibleWindow();
    void updateSidebar();
    void remapSidebar();
    QSize ordinaryBounds(const QScreen *screen) const;
    void fitOrdinary();
    void replaceSurface(const std::function<void()> &change);
    void accept();
    void send(QLocalSocket *client, const QJsonObject &message);
    void setError(const QString &message);
    QQuickWindow ordinary;
    QQuickWindow sidebar;
    LayerFocus layerFocus;
    QPointer<QQuickItem> body;
    QLocalServer server;
    QHash<QLocalSocket *, QByteArray> clients;
    QPointer<QLocalSocket> bridge;
    QJsonObject status;
    QPointer<QScreen> placedScreen;
    QTimer windowRefit;
    QSettings settings;
    QString mode = "window";
    QString failure;
    int sidebarWidth = 600;
    bool testSurfaces = false;
    bool changingSurface = false;
    bool remapPending = false;
};
