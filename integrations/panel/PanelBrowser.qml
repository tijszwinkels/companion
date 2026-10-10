import QtQuick
import QtWebEngine
import "PanelBrowserPolicy.mjs" as Policy

// Minimal web browser shown in place of the chat inside the Companion panel,
// or pinned above one conversation's chat (PanelContent decides which).
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
//   Downloads, permissions, file selection and the colour/sign-in pickers
//   are declined the same way. Script dialogs (alert, confirm, prompt and
//   the leave-page question) are ordinary page features: they appear in a
//   small dialog over the page and the user answers them.
//
// Controls are hidden by default. A slim status strip always shows the site,
// the loading state and the latest notice. Hovering or clicking the strip, or
// pressing Ctrl+L, reveals the toolbar. The toolbar stays while the pointer is
// over it or while any of its controls has keyboard focus.
//
// This item only asks for presentation changes (Pin, Unpin, Chat, Close) with
// signals. PanelContent owns where the page is shown, which conversation a pin
// belongs to and whether pinning is allowed.
FocusScope {
  id: root
  objectName: "panelBrowser"

  // PanelContent loads this file by URL and binds the theme after creation,
  // so these have neutral defaults instead of being required.
  property color foreground: "#dce5ef"
  property color muted: "#8ba0b8"
  property color accent: "#9fc0f7"
  property color selection: "#293a51"
  property color background: "#161e2b"
  property string fontFamily: "sans-serif"
  property real unit: 1

  // PanelContent sets this while the page is on screen: replacing the chat,
  // or pinned above its conversation while the panel is shown. Otherwise the
  // page stays loaded but its item is hidden, which freezes and mutes it, so
  // it keeps its place without running scripts or playing sound. Hiding the
  // whole Companion window does not change the full browser's visibility, so
  // there it neither freezes nor mutes the page; PanelContent hides a pinned
  // page explicitly instead.
  property bool shown: false
  // True while the page is pinned above a conversation instead of replacing
  // it. It only changes which presentation controls the toolbar offers.
  property bool pinned: false
  // The strip's height: a pinned page never gets less, so its site, notices
  // and the way to its controls stay visible.
  readonly property real chromeHeight: strip.height

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
  // The one script dialog Chromium is waiting for, or null. Chromium sends
  // them one at a time and blocks the page's script until it is answered.
  property var pendingDialog: null
  property string pendingDialogHost: ""
  property bool pendingDialogFocus: false
  // Whether the dialog card fits the page area with at least one line of its
  // message. The card never grows beyond that area (a long message scrolls);
  // a pinned page too short for it shows the question in the strip with an
  // Answer button instead (answerRequested).
  readonly property bool dialogFits: pageDialog.height >= pageDialog.minimumCardHeight + 2 * pageDialog.cardMargin
  readonly property bool dialogInStrip: root.pendingDialog !== null && root.pinned && !root.dialogFits
  // An agent's open request (companion_browser_open) waiting for its page:
  // {answer, url, started}. Answered exactly once, from what actually happened:
  // loaded (including a same-document #fragment), load-failed, cancelled (the
  // user chose to stay on a page that asked before leaving), superseded (a
  // newer request, or the user's own link, form, history, reload, typed
  // address or Close), or, after agentOpenWait, whatever the view then shows.
  property var agentOpen: null
  property int agentOpenWait: 8000

  // Chat: show the conversation (and its input); Pin/Unpin: change the
  // presentation; pageClosed: Close unloaded the page, after returnRequested.
  // answerRequested: the strip's Answer, for a question too large for the pin.
  signal returnRequested()
  signal pinRequested()
  signal unpinRequested()
  signal pageClosed()
  signal answerRequested()

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
    id: agentOpenTimeout
    interval: root.agentOpenWait
    onTriggered: root.agentOpenTimedOut()
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

  // Why an agent must not navigate right now, or "" when it may. The user's
  // own interaction wins: a page question awaiting an answer, or an address
  // being typed in the visible toolbar.
  function userBusyReason() {
    if (root.pendingDialog) return "A page dialog is waiting for the user's answer."
    if (root.shown && addressField.activeFocus) return "The user is typing an address."
    return ""
  }

  // Why an agent's address is refused, or "" when the policy allows it. Lets
  // PanelContent refuse before it changes anything on screen.
  function addressRefusal(url) {
    return Policy.addressFromInput(url).error
  }

  // Navigate for an agent. Unlike openAddress, this moves no keyboard focus,
  // reveals no controls and leaves an address the user is editing untouched
  // (it stays in the field; the strip shows the real site). `answer` receives
  // one result. Returns whether a navigation started.
  function openFromAgent(url, answer) {
    const result = Policy.addressFromInput(url)
    if (result.error !== "") {
      answer({outcome: "refused", reason: result.error})
      return false
    }
    root.finishAgentOpen({outcome: "superseded", reason: "A newer request replaced it."})
    root.loadError = ""
    if (!root.profile) root.profile = profilePrototype.instance()
    pageLoader.active = true
    // Only a new #fragment of the page already shown is a same-document
    // navigation, which Chromium completes without any load event.
    const withoutFragment = function(text) { return String(text).split("#")[0].replace(/\/$/, "") }
    const sameDocument = root.page !== null && result.url.indexOf("#") >= 0
      && withoutFragment(result.url) === withoutFragment(root.pageUrl)
      && !root.sameAddress(result.url, root.pageUrl)
    root.agentOpen = {answer: answer, url: result.url, started: false, sameDocument: sameDocument}
    agentOpenTimeout.restart()
    root.page.url = result.url
    if (!addressField.edited) addressField.text = result.url
    return true
  }

  function finishAgentOpen(result) {
    const pending = root.agentOpen
    if (!pending) return
    root.agentOpen = null
    agentOpenTimeout.stop()
    if (result.url === undefined && root.pageUrl !== "" && root.pageUrl !== "about:blank") {
      result.url = root.pageUrl
    }
    pending.answer(result)
  }

  // Whether a load event belongs to the pending agent open. Qt reports no new
  // LoadStarted when a navigation replaces one still in progress, so an event
  // for the requested address itself counts too. An earlier, aborted load of
  // another address never does.
  function agentLoad(url) {
    if (!root.agentOpen) return false
    if (root.agentOpen.started) return true
    const strip = function(text) { return String(text).replace(/\/$/, "") }
    return strip(url) === strip(root.agentOpen.url)
  }

  function sameAddress(first, second) {
    const strip = function(text) { return String(text).replace(/\/$/, "") }
    return strip(first) === strip(second)
  }

  // The bounded wait ended without a load event: report the view's real state.
  // While a page dialog (such as the leave-page question for this navigation)
  // still awaits the user, keep waiting; the listener's own deadline bounds
  // the tool call and then reports it as unconfirmed.
  function agentOpenTimedOut() {
    const pending = root.agentOpen
    if (!pending) return
    if (root.pendingDialog) {
      agentOpenTimeout.restart()
    } else if (root.page && root.page.loading) {
      root.finishAgentOpen({outcome: "loading", reason: "The page was still loading."})
    } else if (root.sameAddress(root.pageUrl, pending.url)) {
      root.finishAgentOpen({outcome: "loaded", reason: ""})
    } else {
      root.finishAgentOpen({outcome: "load-failed",
        reason: root.agentFailure("The page did not open; the browser still shows another address.")})
    }
  }

  // Page text for a failed agent open: the load error and/or the latest notice.
  function agentFailure(fallback) {
    const parts = [root.loadError, root.notice].filter(function(part) { return part !== "" })
    return parts.length > 0 ? parts.join(" ") : fallback
  }

  // Load typed text. Refused text stays in the field with its reason, so the
  // user can correct it. Returns whether a navigation started.
  function openAddress(text) {
    const result = Policy.addressFromInput(text)
    if (result.error !== "") {
      root.notify(result.error)
      return false
    }
    root.finishAgentOpen({outcome: "superseded", reason: "The user opened another address."})
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

  // Show a page's script dialog. It takes keyboard focus only when the page
  // itself had it, so a page cannot pull focus out of the address field.
  function showDialog(request) {
    request.accepted = true
    if (root.pendingDialog) {
      // Chromium does not overlap dialogs; decline defensively if it did.
      request.dialogReject()
      return
    }
    root.pendingDialogFocus = root.page !== null && root.page.activeFocus
    root.pendingDialogHost = Policy.displayHost(request.securityOrigin.toString())
    dialogInput.text = request.type === JavaScriptDialogRequest.DialogTypePrompt ? request.defaultText : ""
    root.pendingDialog = request
    if (root.pendingDialogFocus) root.focusDialog()
  }

  // Keyboard focus to the pending dialog: when the page had it, or when the
  // user explicitly asked to answer (the strip's Answer). Shown in the strip,
  // the dialog keeps its keys (Enter, Escape) without a visible input.
  function focusDialog() {
    if (!root.pendingDialog) return
    root.pendingDialogFocus = true
    if (root.pendingDialog.type === JavaScriptDialogRequest.DialogTypePrompt && dialogCard.visible) {
      dialogInput.forceActiveFocus()
      dialogInput.selectAll()
    } else pageDialog.forceActiveFocus()
  }

  // Resolve the pending dialog; OK/Leave accept, Cancel/Stay decline.
  function answerDialog(accepted) {
    const request = root.pendingDialog
    if (!request) return
    const restoreFocus = root.pendingDialogFocus && pageDialog.activeFocus
    root.pendingDialog = null
    root.pendingDialogFocus = false
    // Staying on a page that asked before leaving cancels a pending agent open.
    if (!accepted && request.type === JavaScriptDialogRequest.DialogTypeBeforeUnload) {
      root.finishAgentOpen({outcome: "cancelled",
        reason: "The page asked whether to leave it, and the user chose to stay."})
    }
    if (!accepted) request.dialogReject()
    else if (request.type === JavaScriptDialogRequest.DialogTypePrompt) request.dialogAccept(dialogInput.text)
    else request.dialogAccept()
    if (restoreFocus && root.page) root.page.forceActiveFocus()
  }

  function dialogButtons(request) {
    if (!request) return []
    if (request.type === JavaScriptDialogRequest.DialogTypeAlert) return [{label: "OK", accept: true}]
    if (request.type === JavaScriptDialogRequest.DialogTypeBeforeUnload) {
      return [{label: "Stay", accept: false}, {label: "Leave", accept: true}]
    }
    return [{label: "Cancel", accept: false}, {label: "OK", accept: true}]
  }

  // Close unloads the page (the profile keeps cookies and site data); its
  // address stays in the field for reopening. Both actions return to chat.
  // A closed page is no longer pinned anywhere.
  function closePage() {
    root.finishAgentOpen({outcome: "superseded", reason: "The user closed the page."})
    root.answerDialog(false)
    pageLoader.active = false
    root.loadError = ""
    root.returnRequested()
    root.pageClosed()
  }

  function trigger(action) {
    if (action === "back" || action === "forward" || action === "reload") {
      root.finishAgentOpen({outcome: "superseded", reason: "The user navigated in the browser."})
    }
    if (action === "back" && root.page) root.page.goBack()
    else if (action === "forward" && root.page) root.page.goForward()
    else if (action === "reload" && root.page) {
      if (root.page.loading) root.page.stop()
      else root.page.reload()
    } else if (action === "chat") root.returnRequested()
    else if (action === "pin") root.pinRequested()
    else if (action === "unpin") root.unpinRequested()
    else if (action === "close") root.closePage()
  }

  function actionEnabled(action) {
    if (action === "back") return root.page !== null && root.page.canGoBack
    if (action === "forward") return root.page !== null && root.page.canGoForward
    if (action === "reload") return root.page !== null && root.pageUrl !== "" && root.pageUrl !== "about:blank"
    if (action === "close" || action === "pin") return root.page !== null
    return true
  }

  function actionLabel(action) {
    if (action === "back") return "‹"
    if (action === "forward") return "›"
    if (action === "reload") return root.loading ? "×" : "↻"
    if (action === "chat") return "Chat"
    if (action === "pin") return "Pin"
    if (action === "unpin") return "Unpin"
    return "Close"
  }

  function actionName(action) {
    if (action === "back") return "Back"
    if (action === "forward") return "Forward"
    if (action === "reload") return root.loading ? "Stop loading" : "Reload"
    if (action === "chat") return root.pinned ? "Go to the chat input, keeping this page pinned" : "Back to chat, keeping this page"
    if (action === "pin") return "Pin this page above the conversation"
    if (action === "unpin") return "Unpin this page, keeping it for the Browser button"
    return root.pinned ? "Close and unpin this page" : "Close page and return to chat"
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
        // A link, form, history step or reload replaces a pending agent open.
        // Redirects and script navigations of the requested page stay its own.
        const type = request.navigationType
        if (type === WebEngineNavigationRequest.LinkClickedNavigation
          || type === WebEngineNavigationRequest.FormSubmittedNavigation
          || type === WebEngineNavigationRequest.BackForwardNavigation
          || type === WebEngineNavigationRequest.ReloadNavigation) {
          root.finishAgentOpen({outcome: "superseded", reason: "The user opened another page."})
        }
        const decision = Policy.mainFrameDecision(request.url.toString())
        if (decision.allowed) return
        request.reject()
        root.notify(decision.reason)
        root.finishAgentOpen({outcome: "load-failed", reason: decision.reason})
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
      onJavaScriptDialogRequested: request => root.showDialog(request)
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
      // Chromium replaces some refused page-initiated navigations (external
      // or privileged schemes) with this inert document, without asking.
      onUrlChanged: {
        if (view.url.toString() === "about:blank#blocked") {
          root.notify("Blocked the page from opening an address the panel browser does not open.")
        }
        // A same-document navigation (a new #fragment) changes the address
        // without loading a document, so no load event will answer it.
        if (root.agentOpen && root.agentOpen.sameDocument) Qt.callLater(view.settleSameDocument)
      }
      function settleSameDocument() {
        const pending = root.agentOpen
        if (pending && pending.sameDocument && !pending.started && !view.loading
          && root.sameAddress(view.url, pending.url)) {
          root.finishAgentOpen({outcome: "loaded", reason: ""})
        }
      }
      onLoadingChanged: info => {
        if (info.status === WebEngineView.LoadStartedStatus) {
          // A new document replaces the one that asked; its question lapses.
          root.answerDialog(false)
          root.loadError = ""
          if (root.agentOpen) root.agentOpen.started = true
        } else if (info.status === WebEngineView.LoadSucceededStatus) {
          if (root.agentLoad(info.url)) {
            // Only the address; page content (even the title) never goes to the agent.
            root.finishAgentOpen({outcome: "loaded", reason: "", url: view.url.toString()})
          }
        } else if (info.status === WebEngineView.LoadFailedStatus && info.errorCode !== -3) {
          // -3 is Chromium's ERR_ABORTED: a stopped or refused navigation,
          // already explained by its own notice.
          const target = Policy.displayHost(info.url.toString()) || "the page"
          root.loadError = "Could not open " + target + ": " + info.errorString
          if (root.agentLoad(info.url)) {
            root.finishAgentOpen({outcome: "load-failed", reason: root.agentFailure(info.errorString)})
          }
        } else if (info.status === WebEngineView.LoadFailedStatus && root.agentLoad(info.url)) {
          // Stopped or refused (e.g. a redirect Chromium dropped): what the
          // user sees is the previous page or an empty one.
          root.finishAgentOpen({outcome: "load-failed", reason: root.agentFailure("The page load was stopped.")})
        }
      }
      onRenderProcessTerminated: (status, exitCode) => {
        root.finishAgentOpen({outcome: "load-failed", reason: "The page stopped unexpectedly."})
        root.answerDialog(false)
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

  // A page's script dialog, over the page but below the toolbar, so Chat and
  // Close stay reachable. The message is page text, shown as plain text
  // under the page's own host name.
  FocusScope {
    id: pageDialog
    objectName: "panelBrowserDialog"
    anchors.fill: pageLoader
    visible: root.pendingDialog !== null
    z: 1
    // The card's height without its message, plus one message line: the
    // least that still shows the origin, the question and its answers.
    readonly property real cardMargin: 6 * root.unit
    readonly property real cardPadding: 12 * root.unit
    readonly property bool hasMessage: dialogMessage.text !== ""
    readonly property bool hasPrompt: root.pendingDialog !== null
      && root.pendingDialog.type === JavaScriptDialogRequest.DialogTypePrompt
    readonly property real minimumCardHeight: 2 * cardPadding + dialogHost.implicitHeight
      + (hasMessage ? dialogColumn.spacing + messageMetrics.height : 0)
      + (hasPrompt ? dialogColumn.spacing + promptBox.height : 0)
      + dialogColumn.spacing + dialogAnswers.implicitHeight
    FontMetrics {
      id: messageMetrics
      font: dialogMessage.font
    }
    Keys.onReturnPressed: root.answerDialog(true)
    Keys.onEnterPressed: root.answerDialog(true)
    Keys.onEscapePressed: root.answerDialog(root.pendingDialog !== null
      && root.pendingDialog.type === JavaScriptDialogRequest.DialogTypeAlert)

    Rectangle {
      anchors.fill: parent
      color: Qt.rgba(root.background.r, root.background.g, root.background.b, 0.6)
      // Blocks pointer input to the page while its dialog is open.
      MouseArea { anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.AllButtons }
    }

    Rectangle {
      id: dialogCard
      objectName: "panelBrowserDialogCard"
      anchors.centerIn: parent
      // The full browser always shows the card, as before; it only shrinks.
      visible: root.dialogFits || !root.pinned
      width: Math.min(parent.width - 24 * root.unit, 380 * root.unit)
      height: dialogColumn.implicitHeight + 2 * pageDialog.cardPadding
      radius: 6 * root.unit
      color: root.background
      border.width: Math.max(1, root.unit)
      border.color: root.selection

      Column {
        id: dialogColumn
        x: 12 * root.unit
        y: 12 * root.unit
        width: parent.width - 24 * root.unit
        spacing: 10 * root.unit

        Text {
          id: dialogHost
          objectName: "panelBrowserDialogHost"
          width: parent.width
          maximumLineCount: 2
          elide: Text.ElideRight
          text: root.pendingDialog && root.pendingDialog.type === JavaScriptDialogRequest.DialogTypeBeforeUnload
            ? "Leave this page? Changes you made may not be saved."
            : (root.pendingDialogHost || "This page") + " says"
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: 11 * root.unit
        }
        // The message scrolls inside whatever height the page area leaves.
        Flickable {
          id: dialogMessageView
          objectName: "panelBrowserDialogMessageView"
          width: parent.width
          visible: pageDialog.hasMessage
          height: Math.min(dialogMessage.implicitHeight, Math.max(messageMetrics.height,
            pageDialog.height - 2 * pageDialog.cardMargin - pageDialog.minimumCardHeight + messageMetrics.height))
          contentHeight: dialogMessage.implicitHeight
          interactive: contentHeight > height
          boundsBehavior: Flickable.StopAtBounds
          clip: true
          Text {
            id: dialogMessage
            objectName: "panelBrowserDialogMessage"
            width: parent.width
            text: root.pendingDialog && root.pendingDialog.type !== JavaScriptDialogRequest.DialogTypeBeforeUnload
              ? root.pendingDialog.message : ""
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 12
            elide: Text.ElideRight
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: 13 * root.unit
          }
        }
        Rectangle {
          id: promptBox
          width: parent.width
          height: 26 * root.unit
          visible: root.pendingDialog !== null && root.pendingDialog.type === JavaScriptDialogRequest.DialogTypePrompt
          radius: 4 * root.unit
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
          border.width: dialogInput.activeFocus ? Math.max(1, root.unit) : 0
          border.color: root.accent
          TextInput {
            id: dialogInput
            objectName: "panelBrowserDialogInput"
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
            onAccepted: root.answerDialog(true)
            Accessible.role: Accessible.EditableText
            Accessible.name: "Answer to the page"
          }
        }
        Row {
          id: dialogAnswers
          anchors.right: parent.right
          spacing: 6 * root.unit
          Repeater {
            model: root.dialogButtons(root.pendingDialog)
            delegate: Rectangle {
              id: dialogButton
              required property var modelData
              objectName: "panelBrowserDialog-" + modelData.label
              implicitWidth: Math.max(60 * root.unit, dialogLabel.implicitWidth + 20 * root.unit)
              implicitHeight: 28 * root.unit
              radius: 4 * root.unit
              color: dialogMouse.containsMouse || activeFocus ? root.selection
                : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
              border.width: activeFocus ? Math.max(1, root.unit) : 0
              border.color: root.accent
              activeFocusOnTab: true
              Keys.onReturnPressed: root.answerDialog(modelData.accept)
              Keys.onEnterPressed: root.answerDialog(modelData.accept)
              Keys.onSpacePressed: root.answerDialog(modelData.accept)
              Text {
                id: dialogLabel
                anchors.centerIn: parent
                text: dialogButton.modelData.label
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: 12 * root.unit
              }
              MouseArea {
                id: dialogMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.answerDialog(dialogButton.modelData.accept)
              }
              Accessible.role: Accessible.Button
              Accessible.name: dialogButton.modelData.label
              Accessible.onPressAction: root.answerDialog(dialogButton.modelData.accept)
            }
          }
        }
      }
    }
    Accessible.role: Accessible.Dialog
    Accessible.name: "Message from the page"
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
        anchors.right: stripAnswer.visible ? stripAnswer.left : revealHint.left
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
          const question = root.dialogInStrip ? " · " + (root.pendingDialogHost || "The page") + " is waiting for an answer" : ""
          return site + local + state + question + message
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

      // A question from a pin too short to show it: an explicit way to answer.
      Rectangle {
        id: stripAnswer
        objectName: "panelBrowserAnswer"
        visible: root.dialogInStrip
        anchors.right: revealHint.left
        anchors.rightMargin: 6 * root.unit
        anchors.verticalCenter: parent.verticalCenter
        width: answerLabel.implicitWidth + 12 * root.unit
        height: parent.height - 4 * root.unit
        radius: 3 * root.unit
        color: answerMouse.containsMouse ? root.selection : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.2)
        Text {
          id: answerLabel
          anchors.centerIn: parent
          text: "Answer"
          textFormat: Text.PlainText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: 11 * root.unit
        }
        MouseArea {
          id: answerMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.answerRequested()
        }
        Accessible.role: Accessible.Button
        Accessible.name: "Answer the page's question in the full panel"
        Accessible.onPressAction: root.answerRequested()
      }
      Accessible.role: Accessible.Button
      Accessible.name: "Show browser controls"
      Accessible.description: status.text
      Accessible.onPressAction: root.revealControls()
    }

    FocusScope {
      id: toolbar
      objectName: "panelBrowserToolbar"
      // In a narrow panel the exit buttons move to a second row, so the
      // address field keeps a usable width and nothing overlaps.
      readonly property bool twoRows: width < navigation.width + exits.width + 140 * root.unit
      readonly property real rowHeight: 34 * root.unit
      y: strip.height
      width: parent.width
      height: (twoRows ? 2 : 1) * rowHeight
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
        y: (toolbar.rowHeight - height) / 2
        spacing: 2 * root.unit
        Repeater {
          model: ["back", "forward", "reload"]
          delegate: buttonDelegate
        }
      }

      Rectangle {
        id: addressBox
        anchors.left: navigation.right
        anchors.right: toolbar.twoRows ? parent.right : exits.left
        anchors.leftMargin: 4 * root.unit
        anchors.rightMargin: 4 * root.unit
        y: (toolbar.rowHeight - height) / 2
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
        y: (toolbar.twoRows ? toolbar.rowHeight : 0) + (toolbar.rowHeight - height) / 2
        spacing: 2 * root.unit
        // Pin (Unpin while pinned) comes last, so the full browser's keyboard
        // order (Tab from the address to Chat, then Close) is kept.
        Repeater {
          model: ["chat", "close", "pin"]
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
      // The presentation slot is one button whose action follows the pin, so
      // pinning never recreates the toolbar buttons (or drops their focus).
      readonly property string action: modelData === "pin" && root.pinned ? "unpin" : modelData
      objectName: "panelBrowser-" + action
      enabled: root.actionEnabled(action)
      implicitWidth: Math.max(26 * root.unit, label.implicitWidth + 12 * root.unit)
      implicitHeight: 26 * root.unit
      radius: 4 * root.unit
      color: mouse.containsMouse || activeFocus ? root.selection : "transparent"
      border.width: activeFocus ? Math.max(1, root.unit) : 0
      border.color: root.accent
      opacity: enabled ? 1 : 0.4
      activeFocusOnTab: true
      Keys.onReturnPressed: root.trigger(action)
      Keys.onEnterPressed: root.trigger(action)
      Keys.onSpacePressed: root.trigger(action)

      Text {
        id: label
        anchors.centerIn: parent
        text: root.actionLabel(button.action)
        textFormat: Text.PlainText
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: (["chat", "close", "pin", "unpin"].indexOf(button.action) >= 0 ? 11 : 15) * root.unit
      }
      MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.trigger(button.action)
      }
      Accessible.role: Accessible.Button
      Accessible.name: root.actionName(action)
      Accessible.onPressAction: if (button.enabled) root.trigger(button.action)
    }
  }

  Shortcut {
    sequence: "Ctrl+L"
    context: Qt.WindowShortcut
    enabled: root.shown && root.visible
    onActivated: root.revealControls()
  }
}
