#pragma once

#include <QWebEngineUrlScheme>

// Call before WebEngine creates its first profile. The schemes supply neither
// file access nor a CSP bypass; only each profile's own handler serves them.
// - companion-widget: restricted widget/session-app views, brokered to their
//   capability-scoped local endpoint (WidgetProfile).
// - companion-shell: Companion's own trusted HTML chat and rail pages, read
//   from the fixed built bundle (ShellProfile). It has no fetch access.
inline void registerWidgetScheme() {
    QWebEngineUrlScheme scheme("companion-widget");
    scheme.setSyntax(QWebEngineUrlScheme::Syntax::Host);
    scheme.setFlags(QWebEngineUrlScheme::SecureScheme
                    | QWebEngineUrlScheme::CorsEnabled
                    | QWebEngineUrlScheme::FetchApiAllowed);
    QWebEngineUrlScheme::registerScheme(scheme);

    QWebEngineUrlScheme shell("companion-shell");
    shell.setSyntax(QWebEngineUrlScheme::Syntax::Host);
    shell.setFlags(QWebEngineUrlScheme::SecureScheme);
    QWebEngineUrlScheme::registerScheme(shell);
}
