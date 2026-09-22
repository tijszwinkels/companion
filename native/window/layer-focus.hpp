#pragma once

#include <QObject>
#include <memory>

class QWindow;

// A dismissible keyboard grab for a user-summoned layer surface. Unlike xdg
// activation, this protocol can focus a Hyprland layer and keeps it focused
// until an outside click, another grab, or an explicit release.
// Optional Hyprland protocol for explicitly requested layer-surface focus.
// The compositor dismisses it on outside input; callers release on hide/move.
class LayerFocus : public QObject {
    Q_OBJECT
public:
    explicit LayerFocus(QObject *parent = nullptr);
    ~LayerFocus() override;
    void acquire(QWindow *window);
    void release();

signals:
    void cleared();

private:
    void begin();
    struct State;
    std::unique_ptr<State> state;
};
