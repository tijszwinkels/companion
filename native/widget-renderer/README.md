# Direct Chromium widgets

The native path embeds Qt WebEngine's Chromium renderer directly into the
existing QtQuick conversation. Chromium handles drawing, animation, text
selection, pointer input, keyboard input and explicit copy/paste. No PNG capture
or input forwarding loop runs for these views. A 200 ms metadata poll measures
the bubble and applies theme changes; it does not determine animation rate.

The existing widget tools, library bundles, durable state, actions, text fallbacks
and Chromium pop-out remain shared with the portable capture renderer. The
surrounding panel, tabs, focus controls and Omarchy theme stay in the same host.
Hidden views become hidden browser pages, suspending the viewer's state polling;
accepted actions retain the existing service's ownership and shutdown rules.

## Build and test without changing the desktop

```sh
npm run widgets:build
npm run test:widgets-native
```

This builds a QML module, offscreen Qt test runner and private Quickshell binary
under the ignored `native/widget-renderer/build/` directory. It requires CMake,
Make, a C++ compiler, Qt 6.8+ WebEngineQuick/QuickTest development files and
Quickshell's build dependencies. This machine has Qt 6.11.2. The first host build
downloads SHA-256-pinned archives of Quickshell commit
`28771c7c74b42e20afca0b1b63980cb46515537c` and header-only CLI11 2.5.0. CLI11's
installation prefix is inside that private build directory. No package manager,
system install, shell restart, listener restart or desktop input is involved.

`npm run widgets:build-module` rebuilds only the module/test runner. Rebuild the
host too after changing `initialize.hpp`. The source archives retain upstream
licenses; this is a development host, with Quickshell's crash handler disabled.

The host delta is deliberately small: retain a valid program argument, register
the private URL scheme, initialize WebEngine before constructing QGuiApplication,
and link Qt WebEngineQuick. Its Qt argument list includes
`--companion-native-widgets`; the adapter uses that marker to choose direct
rendering. Stock Quickshell does not receive that marker and keeps using capture.
An inherited environment variable cannot accidentally enable WebEngine there.

## Trying it on the desktop

Activating this changes the running **Omarchy shell host**, not just the
Companion listener. Prepare the build and review first, then coordinate an
explicit desktop switch. Development does not perform this switch automatically.

After installing this branch's panel with `npm run omarchy:install` and explicitly
stopping the current Omarchy shell, `npm run widgets:shell` starts the private
host with the existing Omarchy configuration. Its `--no-duplicate` option leaves
an already-running shell alone. It does not kill anything or modify launcher,
autostart, Hyprland or system files. Keep the branch's Companion listener running
to provide widget state. No ASR rebuild is needed.

Returning to the standard Omarchy launcher restores the installed Quickshell and
the capture path. Restarting `npm start` alone does **not** activate native
rendering. The private host is not a system package replacement or an automatic
upgrade path; it must be rebuilt/revalidated when Qt or Quickshell changes.

## Display-content boundary

Each view has a separate off-the-record WebEngine profile with memory-only
caching and rejected cookies, downloads and permissions. The browser uses
`companion-widget://view/`; its scheme handler brokers only document/state GETs
and declared-action POSTs to the exact validated local view capability supplied
by the panel. Request bodies, replies and transfer time are bounded. Redirects
are rejected. A changed view aborts old requests and advances an identity
generation; stale completions cannot publish errors into a replacement view.

The request interceptor blocks ordinary network/file requests. The opaque iframe
and CSP remain in place, with no QWebChannel, shell/file API or native object
exposed to widget JavaScript. WebRTC/WebTransport constructors are disabled before
author code in every frame because those transports bypass HTTP interception.
Popups, file selection, script dialogs, fullscreen and drop navigation are denied.
The launcher rejects environment settings that disable Chromium sandboxing or
web security. Public-network access is not enabled by this implementation.

Unlike the separately launched capture browser, embedded WebEngine shares the
desktop host process for its trusted browser-side integration; it does not put
the entire Omarchy shell in a private network namespace. Chromium renderer
sandboxing, the private profile, request broker and iframe restrictions form
the native boundary. This is a material integration change requiring independent
review, not clearance inherited from the older renderer.

## Validation limits

The native suite uses synthetic widgets, temporary state and an offscreen Qt
window. It checks direct rendering with zero frame captures, saved actions,
typing, draft preservation during zoom/theme/resize, copy/paste, hover controls,
Escape, hide/show, repeated view replacement, full-height Back to chat and saved
state after a service restart. A second fixture starts the prepared Quickshell
binary with a private offscreen FloatingWindow and renders the pipeline's SVG
arrows and controls. It checks animation callbacks with zero captures and retains
a synthetic screenshot at `build/artifacts/native-host.png`. Portable panel and Node tests remain separate.
Offscreen software rendering does not establish live GPU performance, Wayland
focus behavior or smoothness on the user's desktop. A coordinated desktop check
and independent review are still required before presenting a release as ready.

The software-only host probe reported WebGL unavailable on this machine. It
establishes direct HTML/CSS/SVG rendering and browser animation callbacks, not
hardware WebGL support. The native browser permits WebGL; its availability still
depends on the desktop graphics configuration.

Repeated view replacement exposed a broker teardown bug during development:
`QObject::destroyed` caused a synchronous abort/finished callback into the
partially destroyed WebEngine request. The handler now disconnects those
callbacks before aborting, and the replacement regression covers this lifetime.
The separate capture-only Qt input regression currently fails intermittently on
this machine, including in an untouched archive of base `e9b7149`. Instrumentation
observed a press at half its supplied coordinates and a release at the full
coordinates during density capture. The existing capture implementation is
unchanged here; native input does not use that transport. This remains an open
capture-path limitation, not a passing check for this candidate.
