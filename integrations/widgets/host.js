// Trusted host for both the offscreen surface and Chromium pop-out. Library
// code lives only in the opaque iframe and sees data/actions, never this host's
// capability URL. Each message is tied to that iframe's actual window identity.
const bootstrap = window.widgetBootstrap;
// Both HTTP pop-outs and the native profile's private scheme use the same
// viewer. Resolve its API against the actual document URL, never iframe input.
const api = bootstrap.api ? location.href.replace(/\/$/, '') : null;
let theme = bootstrap.theme;
// An embedding Companion host that calls setTheme owns the whole theme,
// including text scale. Without one (the Chromium pop-out), refresh() follows
// the text scale the service last received from the sidebar view.
let hostOwnsTheme = false;
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
  await command({ kind: 'update', props, theme });
  revision = nextRevision;
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
    if (
      typeof message.id !== 'string' ||
      message.id.length > 100 ||
      typeof message.action !== 'string' ||
      new TextEncoder().encode(JSON.stringify(message.args ?? {})).byteLength > 32768 ||
      requests.length >= 8 ||
      liveActions >= 8
    ) {
      reply(message.id, null, 'Too many widget actions or oversized arguments');
      return;
    }
    const request = {
      id: message.id,
      action: message.action,
      args: message.args,
      revision,
      requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    };
    if (api) {
      liveActions++;
      void fetch(api + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok) {
            throw Error(value.error);
          }
          await refresh();
          reply(message.id, value);
        })
        .catch((error) => reply(message.id, null, error.message))
        .finally(() => {
          liveActions--;
        });
    } else {
      requests.push(request);
    }
  }
});

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
  if (hostOwnsTheme || typeof value !== 'number' || !(value >= 0.5 && value <= 3)) {
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

window.widgetHost = { command, update, reply, setTheme, takeRequests: () => requests.splice(0) };
void update(bootstrap.props, bootstrap.theme, revision)
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
