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
frame.srcdoc = bootstrap.document;
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

function reply(id, result, error) {
  frame.contentWindow.postMessage({ type: 'action-result', id, result, error }, '*');
  status.textContent = error || '';
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
  void fetch(api + '/state')
    .then(async (response) => {
      const value = await response.json();
      if (!response.ok) {
        throw Error(value.error);
      }
      return { revision: value.revision, data: value.props };
    })
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
    const response = await fetch(api + '/state');
    if (!response.ok) {
      throw Error('Widget is unavailable');
    }
    const snapshot = await response.json();
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
  })
  .catch((error) => {
    status.textContent = error.message;
  });
if (api) {
  setInterval(() => {
    if (document.hidden) {
      return;
    }
    void refresh().catch((error) => {
      status.textContent = error.message;
    });
  }, 400);
}
