// Trusted host for both the offscreen surface and Chromium pop-out. Library
// code lives only in the opaque iframe and sees data/actions, never this host's
// capability URL. Each message is tied to that iframe's actual window identity.
const bootstrap = window.widgetBootstrap;
// Both HTTP pop-outs and the native profile's private scheme use the same
// viewer. Resolve its API against the actual document URL, never iframe input.
const api = bootstrap.api ? location.href.replace(/\/$/, '') : null;
let theme = bootstrap.theme;
// Session application views (src/session-apps/README.md) carry the code version
// they were loaded with. Requests name it, so replaced code is never executed
// for this page; the page reloads itself when the service reports a new one.
const application = bootstrap.application ?? null;
let currentProps = bootstrap.props;
// An embedding Companion host that calls setTheme owns the whole theme,
// including text scale. Without one (the Chromium pop-out), refresh() follows
// the text scale the service last received from the sidebar view.
let hostOwnsTheme = false;
// Companion's effective text-scale range; see src/widgets/types.ts.
const minimumTextScale = 0.4;
const maximumTextScale = 6;
const frame = document.createElement('iframe');
frame.setAttribute('sandbox', 'allow-scripts allow-forms');
frame.setAttribute('referrerpolicy', 'no-referrer');
frame.setAttribute(
  'allow',
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; serial 'none'; bluetooth 'none'; display-capture 'none'",
);
frame.title = bootstrap.title;
// Widget code must not open WebRTC connections: CSP `webrtc 'block'` is not
// enforced by Chromium, and no permission covers it, so an RTCPeerConnection
// could send STUN/ICE packets anywhere from the browser's network. This
// script runs first in the inner document, before frame.js imports the
// widget module, and makes the constructors undefined in its only realm, as
// the desktop's native widget view does in every frame (NativeWidgetView.qml,
// same list). The inner policy has `frame-src 'none'` and the sandbox no
// popups, so widget code gets no fresh window to take them from. It is a
// `data:` script because the inner document also inherits this page's
// policy, which allows no inline scripts. Both routes, both hosts.
const withoutWebRtc =
  '<script src="data:text/javascript,' +
  encodeURIComponent(
    "for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'WebTransport']) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });",
  ) +
  '"></script>';
frame.srcdoc = bootstrap.document.replace('<head>', '<head>' + withoutWebRtc);
document.body.append(frame);
const status = document.createElement('div');
status.className = 'error';
status.setAttribute('role', 'status');
document.body.append(status);
const waiting = new Map();
const requests = [];
let next = 0;
let revision = bootstrap.revision;
let liveActions = 0;
let readyResolve;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});

// Embedded in the browser shell (integrations/shell/README.md, "Inline
// widgets"): served on the widget service's socket route, whose documents
// carry the fixed marker 'location' instead of an address
// (src/widgets/socket.ts), and framed by another page, which the frame
// origin's `frame-ancestors` limits to the gateway's own pages. Only then
// does this page talk to its parent; on the loopback route (desktop panel,
// pop-out) it installs no listener for it and posts nothing to it.
const shellEmbedded = bootstrap.api === 'location' && window.parent !== window;
// Whether the shell shows this frame. Polling stops while it does not. An
// embedded page waits for the shell's first `visible` (sent when the frame
// has loaded), so a frame out of view never polls; elsewhere it is always
// true, as before.
let shellVisible = !shellEmbedded;
// The first height goes to the shell only once the first state was drawn
// (the inner frame reports a height before that too); later ones as they
// change.
let shellShown = false;
let shellHeight = null;
// The text of the last polling failure shown in the status line, if any.
let shellPollingError = '';

function command(message) {
  return ready.then(
    () =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(Error('Widget did not respond in time'));
        }, 2000);
        waiting.set(id, { resolve, reject, timer });
        frame.contentWindow.postMessage({ ...message, type: 'command', id }, '*');
      }),
  );
}

async function update(props, theme, nextRevision) {
  await command({ kind: 'update', props, theme, revision: nextRevision });
  revision = nextRevision;
  currentProps = props;
}

function reply(id, result, error, showStatus = true) {
  frame.contentWindow.postMessage({ type: 'action-result', id, result, error }, '*');
  // Chat permission/refusal is part of the authored subscription/read UI. It
  // must not leave a stale global error over a later successful subscription.
  if (showStatus) {
    status.textContent = error || '';
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') {
    return;
  }
  const message = event.data;
  if (message.type === 'ready') {
    readyResolve();
  } else if (message.type === 'geometry' && Number.isFinite(message.height)) {
    window.widgetContentHeight = Math.max(0, Math.min(2200, message.height));
    if (shellEmbedded) {
      reportHeightToShell();
    }
  } else if (message.type === 'result') {
    const pending = waiting.get(message.id);
    if (pending) {
      waiting.delete(message.id);
      clearTimeout(pending.timer);
      message.error
        ? pending.reject(Error(String(message.error)))
        : pending.resolve(message.result);
    }
  } else if (message.type === 'action') {
    if (!validRequestId(message.id)) {
      return;
    }
    if (!validOperationName(message.action) || !validArguments(message.args)) {
      reply(message.id, null, 'Invalid widget action name or arguments');
      return;
    }
    if (requests.length >= 8 || liveActions >= 8) {
      reply(message.id, null, 'Too many widget actions or oversized arguments');
      return;
    }
    const request = {
      id: message.id,
      action: message.action,
      args: message.args,
      requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    };
    if (application) {
      // Application actions are targeted changes validated against current
      // state, so they do not require the displayed revision.
      request.version = application.version;
    } else {
      // Widgets reject a click on a stale displayed revision.
      request.revision = revision;
    }
    if (api) {
      send('/action', request, message.id, true);
    } else {
      requests.push(request);
    }
  } else if (message.type === 'query' && application) {
    if (!validRequestId(message.id)) {
      return;
    }
    if (!validOperationName(message.name) || !validArguments(message.args)) {
      reply(message.id, null, 'Invalid application query name or arguments');
      return;
    }
    if (liveActions >= 8) {
      reply(message.id, null, 'Too many application queries or oversized arguments');
      return;
    }
    if (!api) {
      reply(message.id, null, 'Application queries need a live view');
      return;
    }
    const query = { name: message.name, args: message.args, version: application.version };
    send('/query', query, message.id, false);
  } else if (message.type === 'chat-watch' && application) {
    // One subscription flag, not an unbounded table controlled by the frame.
    if (typeof message.watching === 'boolean') {
      if (message.watching && !chatWatching) {
        chatNeedsSnapshot = true;
      }
      chatWatching = message.watching;
      if (chatWatching) {
        publishChat(false);
      }
    }
  } else if (message.type === 'chat-read') {
    if (!validRequestId(message.id)) {
      return;
    }
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'id')) {
      reply(message.id, null, 'Chat reads accept no arguments', false);
      return;
    }
    readChat(message.id);
  } else if (['chat-prepare-send', 'chat-send', 'chat-receipt'].includes(message.type)) {
    if (validRequestId(message.id)) {
      sendChatOperation(message);
    }
  } else if (message.type === 'state-read') {
    if (!validRequestId(message.id)) {
      return;
    }
    readState(message.id);
  } else if (validRequestId(message.id)) {
    reply(message.id, null, 'Unsupported widget request');
  }
});

// Ingress checks for requests from authored code, which may post anything
// structured-cloneable directly. An invalid request ID cannot be answered
// safely, so such messages are ignored; every other refusal is answered, so
// the frame's pending request is always released.
function validRequestId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 100;
}

// Manifest operation names are at most 48 characters (src/widgets/registry.ts).
function validOperationName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 48;
}

// Arguments must be JSON (cyclic or otherwise non-JSON values are refused,
// never thrown out of this listener) and at most 32 KiB once serialized.
function validArguments(args) {
  let json;
  try {
    json = JSON.stringify(args ?? {});
  } catch {
    return false;
  }
  return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= 32768;
}

// Sending has its own explicit, finite backend grant. Prepare returns an identity
// BEFORE any possible admission; it is not a reservation or permission renewal.
// Keep no unbounded handle table here. Exact retries/probes use the caller's
// retained handle, and the backend owns deduplication across views/reloads.
function validSendHandle(handle) {
  return (
    handle &&
    typeof handle === 'object' &&
    !Array.isArray(handle) &&
    Object.keys(handle).length === 3 &&
    Object.keys(handle).every((key) => ['version', 'grantId', 'requestId'].includes(key)) &&
    handle.version === application?.version &&
    typeof handle.grantId === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(handle.grantId) &&
    typeof handle.requestId === 'string' &&
    /^[a-zA-Z0-9_-]{16,128}$/.test(handle.requestId)
  );
}

async function sendChatOperation(message) {
  const prepare = message.type === 'chat-prepare-send';
  const sending = message.type === 'chat-send';
  const keys = prepare
    ? ['type', 'id']
    : sending
      ? ['type', 'id', 'handle', 'text']
      : ['type', 'id', 'handle'];
  const refuse = (error) => reply(message.id, null, error, false);
  if (
    Object.keys(message).length !== keys.length ||
    Object.keys(message).some((key) => !keys.includes(key)) ||
    (!prepare && !validSendHandle(message.handle)) ||
    (sending &&
      (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 4000))
  ) {
    refuse('Expected an exact send handle and bounded text; no origin or permission arguments');
    return;
  }
  if (!application || !api || (prepare && document.hidden)) {
    refuse('Preparing a send needs a visible live application');
    return;
  }
  if (liveActions >= 8) {
    refuse('Too many widget requests');
    return;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  liveActions++;
  try {
    if (prepare) {
      // Obtain a fresh observed grant, not an app-supplied field or a cached
      // optimistic acknowledgement. The backend still rechecks on admission.
      const state = await fetchState({ signal: abort.signal });
      const grant = state.chatSend;
      if (
        document.hidden ||
        state.version !== application.version ||
        grant?.allowed !== true ||
        !(grant.remaining > 0)
      ) {
        throw Error('Chat sending needs current trusted consent and remaining quota');
      }
      const handle = {
        version: application.version,
        grantId: grant.grantId,
        requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      };
      if (!validSendHandle(handle)) {
        throw Error('Invalid sending permission');
      }
      reply(message.id, handle, '', false);
      return;
    }

    // No read grant or current-grant observation gate here: an old, already
    // admitted handle must remain probeable after revocation/renewal. Current
    // code/owner and original grant are checked by the service on every call.
    const body = { ...message.handle, ...(sending ? { text: message.text } : {}) };
    const response = await fetch(api + (sending ? '/chat-send' : '/chat-receipt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!response.ok) {
      throw Error('Chat operation was not confirmed');
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 4096) {
      throw Error('Chat receipt exceeds the response limit');
    }
    const value = JSON.parse(text);
    const receipt = value?.receipt;
    if (receipt === null && !sending) {
      reply(message.id, null, '', false);
      return;
    }
    if (
      !receipt ||
      receipt.version !== message.handle.version ||
      receipt.grantId !== message.handle.grantId ||
      receipt.requestId !== message.handle.requestId ||
      !['reserved', 'queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(
        receipt.state,
      )
    ) {
      throw Error('Invalid chat receipt');
    }
    reply(message.id, receipt, '', false);
  } catch (error) {
    // Qt deliberately hides non-200 bodies/status. Even a timeout, malformed
    // response or lost acknowledgement may follow admission. Never replay.
    refuse(
      prepare
        ? String(error.message || error).slice(0, 200)
        : 'Chat outcome is unconfirmed; retain the original handle and inspect its receipt. Do not automatically resend.',
    );
  } finally {
    clearTimeout(timer);
    liveActions--;
  }
}

// Optional, text-only chat reads. Neither the frame nor its state/actions may
// grant access, select a conversation/version, or choose the polling cursor.
// The service authorizes every request; this observed flag only avoids useless
// requests and withdraws local cached/in-flight delivery after a known revoke.
let chatAllowed = false;
let chatEpoch = 0;
let chatWatching = false;
let chatNeedsSnapshot = false;
let chatSnapshot = null;
let chatFlight = null;
let lastChatRead = -Infinity;

function publishChat(includeSnapshot = true, error = '') {
  if (chatWatching) {
    frame.contentWindow.postMessage(
      {
        type: 'chat-update',
        available: chatAllowed,
        snapshot: includeSnapshot && chatAllowed ? chatSnapshot : null,
        error,
      },
      '*',
    );
  }
}

function withdrawChat(error = 'Chat reading is not currently permitted') {
  chatEpoch++;
  chatAllowed = false;
  chatSnapshot = null;
  if (chatFlight) {
    for (const id of chatFlight.readers.splice(0)) {
      reply(id, null, error, false);
    }
    chatFlight.abort.abort();
  }
  publishChat(false, error);
}

// Every authoritative state observation has the same read-delivery effects,
// including explicit reads and send preparation (not just interval refresh).
// Transport/status/parse failures withdraw old delivery. Sender quota/consent
// refusals happen AFTER this helper and must not revoke independent reading.
async function fetchState(options) {
  try {
    const response = await fetch(api + '/state', options);
    const snapshot = await response.json();
    if (!response.ok) {
      throw Error(typeof snapshot?.error === 'string' ? snapshot.error : 'Widget is unavailable');
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw Error('Invalid application state');
    }
    observeChatAccess(snapshot);
    return snapshot;
  } catch (error) {
    if (application) {
      withdrawChat('Application connection is unavailable');
    }
    throw error;
  }
}

function observeChatAccess(snapshot) {
  if (!application) {
    return;
  }
  const allowed = snapshot.version === application.version && snapshot.chatReadAllowed === true;
  if (!allowed && chatAllowed) {
    withdrawChat();
  } else if (allowed && !chatAllowed && !document.hidden) {
    chatEpoch++;
    chatAllowed = true;
    publishChat(false);
  }
}

function readChat(id) {
  const refuse = (error) => {
    if (id !== null) {
      reply(id, null, error, false);
    }
  };
  if (!application || !api || !chatAllowed || document.hidden) {
    refuse('Chat reading is not currently permitted');
    return;
  }
  if (chatFlight) {
    if (chatFlight.epoch !== chatEpoch || chatFlight.readers.length >= 8) {
      refuse('Too many pending chat reads');
    } else if (id !== null) {
      chatFlight.readers.push(id);
    }
    return;
  }
  // Direct raw-frame calls cannot accelerate subscription polling. A recent
  // complete window may satisfy them; an idle window is refreshed, not replayed.
  if (performance.now() - lastChatRead < 400) {
    if (id !== null && chatSnapshot) {
      reply(id, chatSnapshot, '', false);
    } else {
      refuse('Chat reads are busy; wait before reading again');
    }
    return;
  }
  if (liveActions >= 8) {
    refuse('Too many widget requests');
    return;
  }

  const flight = {
    epoch: chatEpoch,
    readers: id === null ? [] : [id],
    abort: new AbortController(),
  };
  chatFlight = flight;
  lastChatRead = performance.now();
  liveActions++;
  const timer = setTimeout(() => flight.abort.abort(), 10000);
  const body = { version: application.version };
  if (chatSnapshot) {
    body.after = chatSnapshot.revision;
  }
  void fetch(api + '/chat-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: flight.abort.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw Error('Chat reading is unavailable; check the trusted permission control');
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 65536) {
        throw Error('Chat response exceeds the text limit');
      }
      const value = JSON.parse(text);
      if (document.hidden && flight.epoch === chatEpoch) {
        withdrawChat('Chat reading is paused while the application is hidden');
      }
      if (flight.epoch !== chatEpoch || !chatAllowed) {
        return;
      }
      if (value.changed === true && Array.isArray(value.messages)) {
        chatSnapshot = value;
      } else if (
        value.changed !== false ||
        !chatSnapshot ||
        value.revision !== chatSnapshot.revision
      ) {
        throw Error('Invalid chat snapshot');
      }
      // Changed results replace the full window, including removed rows. An
      // unchanged result keeps the same window; subscribers need no duplicate.
      if (value.changed || chatNeedsSnapshot) {
        publishChat();
        chatNeedsSnapshot = false;
      }
      for (const reader of flight.readers.splice(0)) {
        reply(reader, chatSnapshot, '', false);
      }
    })
    .catch((error) => {
      if (flight.epoch === chatEpoch) {
        withdrawChat(String(error.message || error).slice(0, 200));
      }
    })
    .finally(() => {
      clearTimeout(timer);
      liveActions--;
      if (chatFlight === flight) {
        chatFlight = null;
      }
    });
}

// Hiding freezes delivery too, not merely the poll timer. Permission is
// re-observed on the next visible state refresh before any subsequent read.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    withdrawChat('Chat reading is paused while the application is hidden');
  }
});
window.addEventListener('pagehide', () => withdrawChat('Application view closed'));

// State reads arrive from authored code, which may post them directly rather
// than through the frame API's own limit. They share one in-flight GET /state:
// at most eight callers wait for it, and it counts once against the same
// eight-request budget as actions and queries. A read that joins an in-flight
// request receives that request's answer, which may be up to one round trip
// old. Capacity is released when the request settles, successfully or not.
const maximumStateReaders = 8;
const stateReaders = [];
let stateReadInFlight = false;

function readState(id) {
  if (!api) {
    reply(id, { revision, data: currentProps });
    return;
  }
  if (stateReaders.length >= maximumStateReaders) {
    reply(id, null, 'Too many pending state reads');
    return;
  }
  if (!stateReadInFlight && liveActions >= 8) {
    reply(id, null, 'Too many widget requests');
    return;
  }
  stateReaders.push(id);
  if (stateReadInFlight) {
    return;
  }

  stateReadInFlight = true;
  liveActions++;
  const settle = (value, error) => {
    stateReadInFlight = false;
    liveActions--;
    for (const reader of stateReaders.splice(0)) {
      reply(reader, value, error);
    }
  };
  void fetchState()
    .then((value) => ({ revision: value.revision, data: value.props }))
    .then(
      (value) => settle(value, ''),
      (error) => settle(null, error.message),
    );
}

// One bounded POST to the view's own capability URL. Mutations refresh the
// displayed state before resolving, so the page sees its own committed change.
function send(path, body, id, refreshAfter) {
  liveActions++;
  void fetch(api + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(async (response) => {
      const value = await response.json();
      if (!response.ok) {
        throw Error(value.error);
      }
      if (refreshAfter) {
        await refresh();
      }
      reply(id, value);
    })
    .catch((error) => reply(id, null, error.message))
    .finally(() => {
      liveActions--;
    });
}

let refreshing = false;
async function refresh() {
  if (refreshing) {
    return;
  }
  refreshing = true;
  try {
    const snapshot = await fetchState();
    if (application && snapshot.version !== application.version) {
      // The application's code was replaced. Load the new document; the
      // capability URL stays the same and state lives in the service.
      location.reload();
      return;
    }
    const sidebarScale = followedTextScale(snapshot.textScale);
    if (snapshot.revision !== revision) {
      if (sidebarScale !== null) {
        theme = { ...theme, scale: sidebarScale };
      }
      await update(snapshot.props, theme, snapshot.revision);
    } else if (sidebarScale !== null) {
      applyTheme({ ...theme, scale: sidebarScale });
    }
  } finally {
    refreshing = false;
  }
}

// Returns the sidebar's text scale when this view should adopt it, else null:
// when a host owns the theme, the value is unknown or invalid, or it is current.
function followedTextScale(value) {
  if (
    hostOwnsTheme ||
    typeof value !== 'number' ||
    !(value >= minimumTextScale && value <= maximumTextScale)
  ) {
    return null;
  }
  return value === theme.scale ? null : value;
}

function applyTheme(value) {
  theme = value;
  void command({ kind: 'theme', theme }).catch((error) => {
    status.textContent = error.message;
  });
}

function setTheme(value) {
  hostOwnsTheme = true;
  applyTheme(value);
}

// The first mount/update with the bootstrap state. Its own outcome is kept:
// a session application is published only if this very attempt succeeded
// (src/widgets/renderer.ts render()); a later retry proves nothing about it.
const initialUpdate = update(bootstrap.props, bootstrap.theme, revision);
window.widgetHost = {
  command,
  update,
  reply,
  setTheme,
  takeRequests: () => requests.splice(0),
  initial: () => initialUpdate.then(() => true),
};
void initialUpdate
  .then(() => {
    window.widgetReady = true;
    if (shellEmbedded) {
      shellShown = true;
      reportHeightToShell();
    }
  })
  .catch((error) => {
    status.textContent = error.message;
    if (shellEmbedded) {
      postToShell({ type: 'error', text: String(error.message || error).slice(0, 200) });
    }
  });
if (api) {
  setInterval(() => {
    if (document.hidden || !shellVisible) {
      return;
    }
    void refresh()
      .then(() => {
        // Embedded, a polling failure the shell's connection loss caused
        // (the frame stays when the shell reconnects to the same address)
        // goes once polling works again; other messages stay as before.
        if (shellEmbedded && shellPollingError && status.textContent === shellPollingError) {
          status.textContent = '';
        }
        shellPollingError = '';
        if (chatWatching && chatAllowed && !document.hidden) {
          readChat(null);
        }
      })
      .catch((error) => {
        if (application) {
          withdrawChat('Application connection is unavailable');
        }
        status.textContent = error.message;
        shellPollingError = error.message;
      });
  }, 400);
}

// ---- Messages with the browser shell (embedded mode only) -------------------
//
// To the shell: { type: 'geometry', height } and { type: 'error', text }.
// From it: { type: 'theme', theme: { foreground, background, accent, muted,
// scale } } and { type: 'visible', visible }. Nothing else is sent or
// accepted; no message grants a permission or names another view. The
// target origin is '*' because this page cannot know its parent's origin
// (the shell frames it without a referrer); `frame-ancestors` already limits
// who can frame it to the gateway's pages, and these messages carry only a
// height and a short error text.

function postToShell(message) {
  window.parent.postMessage(message, '*');
}

function reportHeightToShell() {
  const height = window.widgetContentHeight;
  if (!shellShown || typeof height !== 'number' || height === shellHeight) {
    return;
  }
  shellHeight = height;
  postToShell({ type: 'geometry', height });
}

const shellColour = /^#[0-9a-fA-F]{6}$/;

// A theme from the shell, or null: exactly the four colours as #rrggbb and
// a text scale within Companion's range.
function shellTheme(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const keys = ['foreground', 'background', 'accent', 'muted', 'scale'];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    return null;
  }
  for (const key of ['foreground', 'background', 'accent', 'muted']) {
    if (typeof value[key] !== 'string' || !shellColour.test(value[key])) {
      return null;
    }
  }
  if (
    typeof value.scale !== 'number' ||
    !(value.scale >= minimumTextScale && value.scale <= maximumTextScale)
  ) {
    return null;
  }
  return value;
}

if (shellEmbedded) {
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      !event.data ||
      typeof event.data !== 'object' ||
      Array.isArray(event.data)
    ) {
      return;
    }
    const message = event.data;
    const exactly = (name) => Object.keys(message).length === 2 && Object.hasOwn(message, name);
    if (message.type === 'visible' && exactly('visible') && typeof message.visible === 'boolean') {
      shellVisible = message.visible;
    } else if (message.type === 'theme' && exactly('theme')) {
      const value = shellTheme(message.theme);
      if (value) {
        setTheme({
          ...theme,
          foreground: value.foreground,
          background: value.background,
          accent: value.accent,
          muted: value.muted,
          scale: value.scale,
        });
      }
    }
  });
}
