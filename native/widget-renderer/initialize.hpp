#pragma once

#include <QWebEngineUrlScheme>

// Call before WebEngine creates its first profile. The scheme supplies neither
// file access nor a CSP bypass; only the profile's bounded local broker serves it.
inline void registerWidgetScheme() {
    QWebEngineUrlScheme scheme("companion-widget");
    scheme.setSyntax(QWebEngineUrlScheme::Syntax::Host);
    scheme.setFlags(QWebEngineUrlScheme::SecureScheme
                    | QWebEngineUrlScheme::CorsEnabled
                    | QWebEngineUrlScheme::FetchApiAllowed);
    QWebEngineUrlScheme::registerScheme(scheme);
}
