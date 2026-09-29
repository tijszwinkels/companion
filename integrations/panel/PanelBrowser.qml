import QtQuick
import QtWebEngine
import "PanelBrowserPolicy.mjs" as Policy

// Minimal web browser shown in place of the chat inside the Companion panel.
//
// Loaded only by the native host, which has initialized Qt WebEngine; portable
// hosts never instantiate this file. PanelContent owns one instance for the
// lifetime of its persistent body, so the profile and the current page survive
// conversation changes, reconnects and Window/Sidebar/Dock moves.
//
// This is an ordinary top-level Chromium page, unrelated to widget views:
// - Its named, persistent profile ("companion-panel-browser") is separate from
//   the restricted, off-the-record WidgetProfile, from the user's own browser
//   and from the Chromium profiles of local apps. Chromium creates its storage
//   and cache directories with mode 0700 under the application's data and cache
//   locations. Cookies and site data persist like in a normal browser;
//   permission decisions are never stored.
// - No user scripts, WebChannel, host objects or credentials are given to the
//   page. The normal Chromium sandbox, same-origin policy and TLS checks apply.
// - Top-level navigation follows PanelBrowserPolicy.mjs: https anywhere, http
//   only on loopback. The check runs for typed addresses, links, form posts
//   and server redirects alike.
// - There is one page. New windows, tabs and pop-ups are refused with a
//   visible notice, never opened elsewhere or redirected into this page.
//   Downloads, permissions, file selection and other browser dialogs are
//   declined the same way. alert() text appears in the notice line, and
//   confirm() and prompt() are declined.
//
// Controls are hidden by default. A slim status strip always shows the site,
// the loading state and the latest notice. Hovering or clicking the strip, or
// pressing Ctrl+L, reveals the toolbar. The toolbar stays while the pointer is
// over it or while any of its controls has keyboard focus.
FocusScope {
  id: root
  objectName: "panelBrowser"

  required property color foreground
  required property color muted
  required property color accent
  required property color selection
  required property color background
  required property string fontFamily
  property real unit: 1

  // PanelContent sets this while the browser replaces the chat. A hidden page
  // stays loaded but is frozen and muted, so it keeps its place without
  // running scripts or playing sound in the background.
  property bool shown: false

  readonly property var page: pageLoader.item
  readonly property string pageUrl: page ? page.url.toString() : ""
  readonly property string host: Policy.displayHost(pageUrl)
  readonly property bool loading: page !== null && page.loading
  // Created on first use; lives as long as this item (see profilePrototype).
  property var profile: null
  // A failed load stays visible until the next load starts.
  property string loadError: ""
  // The latest refusal or page message. It fades after noticeDuration.
  property string notice: ""
  property int noticeDuration: 10000
  // Toolbar visibility. controlsWanted is the immediate condition; shown
  // controls linger briefly so moving the pointer across the edge does not
  // flicker, and appear after a short hover so passing over it does not
  // flash them either.
  property bool controlsShown: false
  readonly property bool controlsHovered: chromeHover.hovered
  readonly property bool controlsFocused: toolbar.activeFocus
  readonly property bool controlsWanted: root.shown && (root.page === null
    || root.controlsHovered || root.controlsFocused)
  readonly property alias addressText: addressField.text
  readonly property alias addressEdited: addressField.edited

  signal returnRequested()

  function updateControls() {
    if (root.controlsWanted && (root.controlsFocused || root.page === null)) {
      revealDelay.stop()
      hideDelay.stop()
      root.controlsShown = true
    } else if (root.controlsWanted) {
      hideDelay.stop()
      if (!root.controlsShown) revealDelay.restart()
    } else {
      revealDelay.stop()
      hideDelay.restart()
    }
  }
  onControlsWantedChanged: updateControls()
  onShownChanged: if (!root.shown) root.controlsShown = false
  Component.onCompleted: updateControls()

  Timer {
    id: revealDelay
    interval: 150
    onTriggered: if (root.controlsWanted) root.controlsShown = true
  }
  Timer {
    id: hideDelay
    interval: 700
    onTriggered: if (!root.controlsWanted) root.controlsShown = false
  }
  Timer {
    id: noticeExpiry
    interval: root.noticeDuration
    onTriggered: root.notice = ""
  }

  // Called by PanelContent when the user opens the browser. With a page, the
  // page gets keyboard focus; without one, the address field does. Nothing
  // else in this component moves focus on its own.
  function focusBrowser() {
    if (root.page) root.page.forceActiveFocus()
    else root.revealControls()
  }

  // Keyboard/explicit reveal: show the toolbar and edit the address.
  function revealControls() {
    root.controlsShown = true
    addressField.forceActiveFocus()
    addressField.selectAll()
  }

  function notify(text) {
    // Page-supplied text is shown as plain text on one line.
    root.notice = String(text).replace(/\s+/g, " ").trim().slice(0, 300)
    noticeExpiry.restart()
  }

  // Load typed text. Refused text stays in the field with its reason, so the
  // user can correct it. Returns whether a navigation started.
  function openAddress(text) {
    const result = Policy.addressFromInput(text)
    if (result.error !== "") {
      root.notify(result.error)
      return false
    }
    root.loadError = ""
    addressField.edited = false
    if (!root.profile) root.profile = profilePrototype.instance()
    pageLoader.active = true
    root.page.url = result.url
    addressField.text = result.url
    root.page.forceActiveFocus()
    return true
  }

  function cancelAddressEdit() {
    addressField.edited = false
    root.synchronizeAddress()
    if (root.page) root.page.forceActiveFocus()
  }

  // A page change never overwrites an address the user is still editing.
  function synchronizeAddress() {
    if (addressField.edited || !root.page) return
    addressField.text = root.pageUrl === "about:blank" ? "" : root.pageUrl
  }
  onPageUrlChanged: synchronizeAddress()

  // Close unloads the page (the profile keeps cookies and site data); its
  // address stays in the field for reopening. Both actions return to chat.
  function closePage() {
    pageLoader.active = false
    root.loadError = ""
    root.returnRequested()
  }

  function trigger(action) {
    if (action === "back" && root.page) root.page.goBack()
    else if (action === "forward" && root.page) root.page.goForward()
    else if (action === "reload" && root.page) {
      if (root.page.loading) root.page.stop()
      else root.page.reload()
    } else if (action === "chat") root.returnRequested()
    else if (action === "close") root.closePage()
  }

  function actionEnabled(action) {
    if (action === "back") return root.page !== null && root.page.canGoBack
    if (action === "forward") return root.page !== null && root.page.canGoForward
    if (action === "reload") return root.page !== null && root.pageUrl !== "" && root.pageUrl !== "about:blank"
    if (action === "close") return root.page !== null
    return true
  }

  function actionLabel(action) {
    if (action === "back") return "‹"
    if (action === "forward") return "›"
    if (action === "reload") return root.loading ? "×" : "↻"
    if (action === "chat") return "Chat"
    return "Close"
  }

  function actionName(action) {
    if (action === "back") return "Back"
    if (action === "forward") return "Forward"
    if (action === "reload") return root.loading ? "Stop loading" : "Reload"
    if (action === "chat") return "Back to chat, keeping this page"
    return "Close page and return to chat"
  }

  function permissionName(type) {
    if (type === WebEnginePermission.PermissionType.MediaAudioCapture) return "Microphone access"
    if (type === WebEnginePermission.PermissionType.MediaVideoCapture) return "Camera access"
    if (type === WebEnginePermission.PermissionType.MediaAudioVideoCapture) return "Camera and microphone access"
    if (type === WebEnginePermission.PermissionType.DesktopVideoCapture
      || type === WebEnginePermission.PermissionType.DesktopAudioVideoCapture) return "Screen sharing"
    if (type === WebEnginePermission.PermissionType.Notifications) return "Showing notifications"
    if (type === WebEnginePermission.PermissionType.Geolocation) return "Location access"
    if (type === WebEnginePermission.PermissionType.ClipboardReadWrite) return "Clipboard access"
    if (type === WebEnginePermission.PermissionType.MouseLock) return "Pointer lock"
    if (type === WebEnginePermission.PermissionType.LocalFontsAccess) return "Local font access"
    return "This permission"
  }

  // Declared before the profile prototype: QObject children are destroyed in
  // declaration order, so the page is gone before its profile is released.
  Loader {
    id: pageLoader
    objectName: "panelBrowserPageLoader"
    active: false
    anchors.top: parent.top
    anchors.topMargin: strip.height
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    sourceComponent: pageComponent
  }

  Component {
    id: pageComponent

    WebEngineView {
      id: view
      objectName: "panelBrowserView"
      profile: root.profile
      focus: true
      // A hidden page cannot be frozen until Qt has applied the new visibility;
      // freeze on the next turn of the event loop, and wake immediately.
      audioMuted: !visible
      onVisibleChanged: {
        if (visible) view.lifecycleState = WebEngineView.LifecycleState.Active
        else Qt.callLater(view.freezeIfHidden)
      }
      function freezeIfHidden() {
        if (!view.visible && view.lifecycleState === WebEngineView.LifecycleState.Active) {
          view.lifecycleState = WebEngineView.LifecycleState.Frozen
        }
      }

      // Pop-ups reach newWindowRequested (and its visible refusal) rather than
      // being dropped silently by Chromium's own blocker.
      settings.javascriptCanOpenWindows: true
      settings.allowWindowActivationFromJavaScript: false
      settings.javascriptCanAccessClipboard: false
      settings.javascriptCanPaste: false
      settings.localContentCanAccessFileUrls: false
      settings.localContentCanAccessRemoteUrls: false
      settings.allowRunningInsecureContent: false
      settings.fullScreenSupportEnabled: false
      settings.screenCaptureEnabled: false
      settings.navigateOnDropEnabled: false
      settings.focusOnNavigationEnabled: false
      settings.webRTCPublicInterfacesOnly: true
      // mailto:, tel: and other external schemes never launch a handler.
      settings.unknownUrlSchemePolicy: WebEngineSettings.DisallowUnknownUrlSchemes

      onNavigationRequested: request => {
        if (!request.isMainFrame) return
        const decision = Policy.mainFrameDecision(request.url.toString())
        if (decision.allowed) return
        request.reject()
        root.notify(decision.reason)
      }
      onNewWindowRequested: request => {
        // Not calling openIn() discards the new window.
        const target = Policy.displayHost(request.requestedUrl.toString())
        root.notify("Blocked a pop-up" + (target ? " to " + target : "")
          + ". The panel browser shows one page at a time.")
      }
      onPermissionRequested: permission => {
        permission.deny()
        root.notify(root.permissionName(permission.permissionType) + " is not available in the panel browser.")
      }
      onFileDialogRequested: request => {
        request.accepted = true
        request.dialogReject()
        root.notify("Choosing files is not available in the panel browser.")
      }
      onJavaScriptDialogRequested: request => {
        request.accepted = true
        if (request.type === JavaScriptDialogRequest.DialogTypeAlert) {
          request.dialogAccept()
          root.notify("Page says: " + request.message)
        } else if (request.type === JavaScriptDialogRequest.DialogTypeBeforeUnload) {
          // Leaving is the user's explicit request; do not trap them on a page.
          request.dialogAccept()
        } else {
          request.dialogReject()
          root.notify("Declined a page question: " + request.message)
        }
      }
      onColorDialogRequested: request => {
        request.accepted = true
        request.dialogReject()
        root.notify("The color picker is not available in the panel browser.")
      }
      onAuthenticationDialogRequested: request => {
        request.accepted = true
        request.dialogReject()
        root.notify("Browser sign-in prompts are not available in the panel browser.")
      }
      onFullScreenRequested: request => request.reject()
      // No native menu: it would offer new windows, downloads and developer
      // tools. Keyboard copy and paste keep working.
      onContextMenuRequested: request => request.accepted = true
      onCertificateError: error => {
        error.rejectCertificate()
        root.notify("Blocked " + (Policy.displayHost(error.url.toString()) || "a page")
          + ": its security certificate is not valid.")
      }
      onSelectClientCertificate: selection => selection.selectNone()
      onRegisterProtocolHandlerRequested: request => request.reject()
      onFileSystemAccessRequested: request => {
        request.reject()
        root.notify("File access is not available in the panel browser.")
      }
      onWebAuthUxRequested: request => {
        request.cancel()
        root.notify("Security keys and passkeys are not available in the panel browser.")
      }
      onDesktopMediaRequested: request => request.cancel()
      onPrintRequested: root.notify("Printing is not available in the panel browser.")
      onPrintRequestedByFrame: frame => root.notify("Printing is not available in the panel browser.")
      onLoadingChanged: info => {
        if (info.status === WebEngineView.LoadStartedStatus) {
          root.loadError = ""
        } else if (info.status === WebEngineView.LoadFailedStatus && info.errorCode !== -3) {
          // -3 is Chromium's ERR_ABORTED: a stopped or refused navigation,
          // already explained by its own notice.
          const target = Policy.displayHost(info.url.toString()) || "the page"
          root.loadError = "Could not open " + target + ": " + info.errorString
        }
      }
      onRenderProcessTerminated: (status, exitCode) => {
        root.loadError = "The page stopped unexpectedly. Reload to try again."
      }
    }
  }

  WebEngineProfilePrototype {
    id: profilePrototype
    storageName: "companion-panel-browser"
    httpCacheType: WebEngineProfile.DiskHttpCache
    persistentCookiesPolicy: WebEngineProfile.AllowPersistentCookies
    persistentPermissionsPolicy: WebEngineProfile.PersistentPermissionsPolicy.AskEveryTime
  }

  // Downloads are profile-wide; not accepting one cancels it.
  Connections {
    target: root.profile
    function onDownloadRequested(download) {
      download.cancel()
      root.notify("Downloads are not available in the panel browser.")
    }
  }

  Text {
    anchors.centerIn: pageLoader
    width: Math.min(pageLoader.width - 32 * root.unit, 360 * root.unit)
    visible: root.page === null
    text: "Type a web address above, for example example.com.\nLocal apps also work over http://localhost."
    textFormat: Text.PlainText
    horizontalAlignment: Text.AlignHCenter
    wrapMode: Text.Wrap
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: 12 * root.unit
  }

  // The status strip and the toolbar below it share one hover area.
  Item {
    id: chrome
    objectName: "panelBrowserChrome"
    width: parent.width
    height: strip.height + (root.controlsShown ? toolbar.height : 0)
    z: 2
    HoverHandler { id: chromeHover }

    Rectangle {
      id: strip
      objectName: "panelBrowserStrip"
      width: parent.width
      height: 22 * root.unit
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05)

      Text {
        id: status
        objectName: "panelBrowserStatus"
        anchors.left: parent.left
        anchors.right: revealHint.left
        anchors.leftMargin: 8 * root.unit
        anchors.rightMargin: 8 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
        color: root.loadError !== "" ? "#ef5350" : root.notice !== "" ? root.accent : root.foreground
        text: {
          const site = root.page === null ? "No page open"
            : root.host !== "" ? root.host : "Blank page"
          const local = root.pageUrl.indexOf("http:") === 0 ? " (local, not encrypted)" : ""
          const state = root.loadError !== "" ? " · " + root.loadError
            : root.loading ? " · Loading…" : ""
          const message = root.notice !== "" ? " · " + root.notice : ""
          return site + local + state + message
        }
      }

      Text {
        id: revealHint
        anchors.right: parent.right
        anchors.rightMargin: 8 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        text: root.controlsShown ? "▴" : "▾"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: 11 * root.unit
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: root.revealControls()
      }
      Accessible.role: Accessible.Button
      Accessible.name: "Show browser controls"
      Accessible.description: status.text
      Accessible.onPressAction: root.revealControls()
    }

    FocusScope {
      id: toolbar
      objectName: "panelBrowserToolbar"
      y: strip.height
      width: parent.width
      height: 34 * root.unit
      visible: root.controlsShown

      Rectangle {
        anchors.fill: parent
        color: root.background
        Rectangle {
          anchors.bottom: parent.bottom
          width: parent.width
          height: Math.max(1, root.unit)
          color: root.selection
        }
      }

      Row {
        id: navigation
        anchors.left: parent.left
        anchors.leftMargin: 4 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2 * root.unit
        Repeater {
          model: ["back", "forward", "reload"]
          delegate: buttonDelegate
        }
      }

      Rectangle {
        id: addressBox
        anchors.left: navigation.right
        anchors.right: exits.left
        anchors.leftMargin: 4 * root.unit
        anchors.rightMargin: 4 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        height: 26 * root.unit
        radius: 4 * root.unit
        color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
        border.width: addressField.activeFocus ? Math.max(1, root.unit) : 0
        border.color: root.accent

        TextInput {
          id: addressField
          objectName: "panelBrowserAddress"
          // True from the first keystroke until the edit is submitted or
          // cancelled. Page navigation never replaces an edited address.
          property bool edited: false
          anchors.fill: parent
          anchors.leftMargin: 6 * root.unit
          anchors.rightMargin: 6 * root.unit
          verticalAlignment: TextInput.AlignVCenter
          clip: true
          selectByMouse: true
          activeFocusOnTab: true
          color: root.foreground
          selectionColor: root.selection
          selectedTextColor: root.foreground
          font.family: root.fontFamily
          font.pixelSize: 12 * root.unit
          inputMethodHints: Qt.ImhUrlCharactersOnly | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
          onTextEdited: edited = true
          onAccepted: root.openAddress(text)
          Keys.onEscapePressed: event => {
            event.accepted = true
            root.cancelAddressEdit()
          }
          Accessible.role: Accessible.EditableText
          Accessible.name: "Web address"
        }
        Text {
          anchors.fill: addressField
          verticalAlignment: Text.AlignVCenter
          visible: addressField.text === "" && !addressField.activeFocus
          text: "Web address"
          color: root.muted
          font: addressField.font
        }
      }

      Row {
        id: exits
        anchors.right: parent.right
        anchors.rightMargin: 4 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2 * root.unit
        Repeater {
          model: ["chat", "close"]
          delegate: buttonDelegate
        }
      }
    }
  }

  Component {
    id: buttonDelegate

    Rectangle {
      id: button
      required property string modelData
      objectName: "panelBrowser-" + modelData
      enabled: root.actionEnabled(modelData)
      implicitWidth: Math.max(26 * root.unit, label.implicitWidth + 12 * root.unit)
      implicitHeight: 26 * root.unit
      radius: 4 * root.unit
      color: mouse.containsMouse || activeFocus ? root.selection : "transparent"
      border.width: activeFocus ? Math.max(1, root.unit) : 0
      border.color: root.accent
      opacity: enabled ? 1 : 0.4
      activeFocusOnTab: true
      Keys.onReturnPressed: root.trigger(modelData)
      Keys.onEnterPressed: root.trigger(modelData)
      Keys.onSpacePressed: root.trigger(modelData)

      Text {
        id: label
        anchors.centerIn: parent
        text: root.actionLabel(button.modelData)
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: (button.modelData === "chat" || button.modelData === "close" ? 11 : 15) * root.unit
      }
      MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.trigger(button.modelData)
      }
      Accessible.role: Accessible.Button
      Accessible.name: root.actionName(modelData)
      Accessible.onPressAction: if (button.enabled) root.trigger(button.modelData)
    }
  }

  Shortcut {
    sequence: "Ctrl+L"
    context: Qt.WindowShortcut
    enabled: root.shown && root.visible
    onActivated: root.revealControls()
  }
}
