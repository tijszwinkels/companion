// This entire module runs in an opaque-origin sandbox. It has no Node APIs,
// credentials, network permissions or access to the surrounding application.
const implementation = await import(window.widgetModuleUrl);
const root = document.getElementById('widget');
const pendingActions = new Map();
let nextAction = 0;
let controller;
function applyTheme(theme) {
  for (const name of ['foreground', 'background', 'accent', 'muted']) {
    document.documentElement.style.setProperty('--' + name, theme[name]);
  }
  document.documentElement.style.fontSize = `${16 * theme.scale}px`;
}
// Latest state pushed by the host, for subscriptions. Session applications use
// `api.state`/`api.query`; ordinary widgets keep receiving props via update().
let latestState = null;
const stateSubscribers = new Set();
// This is a transient view, never merged into the application's saved state.
// Copies made by authored code cannot be recalled; the native consent UI says so.
const chatSubscribers = new Set();
let latestChat = { available: false, snapshot: null, error: '' };

// Every request to the host shares one bounded table of pending replies.
function request(message) {
  if (pendingActions.size >= 8) {
    return Promise.reject(Error('Widget actions are busy'));
  }
  return new Promise((resolve, reject) => {
    const id = `user-${++nextAction}`;
    pendingActions.set(id, { resolve, reject });
    try {
      parent.postMessage({ ...message, id }, '*');
    } catch (error) {
      // Values that cannot be cloned never reach the host; release the slot.
      pendingActions.delete(id);
      reject(error);
    }
  });
}

const api = {
  call(action, args = {}) {
    return request({ type: 'action', action, args });
  },
  query(name, args = {}) {
    return request({ type: 'query', name, args });
  },
  chat: {
    read() {
      return request({ type: 'chat-read' });
    },
    subscribe(callback) {
      if (typeof callback !== 'function' || chatSubscribers.size >= 32) {
        throw Error('Chat subscribe needs a callback and has a 32-subscriber limit');
      }
      const first = chatSubscribers.size === 0;
      chatSubscribers.add(callback);
      if (first) {
        parent.postMessage({ type: 'chat-watch', watching: true }, '*');
      }
      try {
        callback(structuredClone(latestChat));
      } catch (error) {
        console.error(error);
      }
      return () => {
        chatSubscribers.delete(callback);
        if (chatSubscribers.size === 0) {
          latestChat = { available: false, snapshot: null, error: '' };
          parent.postMessage({ type: 'chat-watch', watching: false }, '*');
        }
      };
    },
  },
  state: {
    read() {
      return request({ type: 'state-read' });
    },
    subscribe(callback) {
      if (typeof callback !== 'function') {
        throw Error('subscribe needs a callback');
      }
      stateSubscribers.add(callback);
      return () => {
        stateSubscribers.delete(callback);
      };
    },
  },
};

function notifySubscribers() {
  for (const callback of stateSubscribers) {
    try {
      callback(structuredClone(latestState));
    } catch (error) {
      console.error(error);
    }
  }
}

window.addEventListener('message', async (event) => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') {
    return;
  }
  const message = event.data;
  if (message.type === 'chat-update') {
    latestChat = {
      available: message.available === true,
      snapshot: message.available === true ? message.snapshot : null,
      error: typeof message.error === 'string' ? message.error : '',
    };
    for (const callback of chatSubscribers) {
      try {
        callback(structuredClone(latestChat));
      } catch (error) {
        console.error(error);
      }
    }
    return;
  }
  if (message.type === 'action-result') {
    const pending = pendingActions.get(message.id);
    pendingActions.delete(message.id);
    if (message.error) {
      pending?.reject(Error(message.error));
    } else {
      pending?.resolve(message.result);
    }
    return;
  }
  if (message.type !== 'command') {
    return;
  }
  try {
    let result;
    if (message.kind === 'update') {
      applyTheme(message.theme);
      controller ??= implementation.mount(root, api);
      await controller.update(structuredClone(message.props));
      const previousRevision = latestState?.revision;
      latestState = { revision: message.revision, data: structuredClone(message.props) };
      if (previousRevision !== message.revision) {
        notifySubscribers();
      }
      result = true;
    } else if (message.kind === 'theme') {
      // Theme-only updates preserve drafts, selection and the current props.
      applyTheme(message.theme);
      result = true;
    } else if (message.kind === 'reduce') {
      const action = implementation.actions?.[message.action];
      if (typeof action !== 'function') {
        throw Error('Widget action is not implemented');
      }
      result = await action(structuredClone(message.props), structuredClone(message.args), {
        requestId: message.requestId,
      });
    } else if (message.kind === 'query') {
      // Application queries read a clone. Nothing they change is saved.
      const query = implementation.queries?.[message.name];
      if (typeof query !== 'function') {
        throw Error('Application query is not implemented');
      }
      result = await query(structuredClone(message.props), structuredClone(message.args));
    } else if (message.kind === 'inspect') {
      // The host checks that a bundle implements what its manifest declares
      // before an application is installed.
      result = {
        mount: typeof implementation.mount === 'function',
        describe: typeof implementation.describe === 'function',
        actions: Object.keys(implementation.actions ?? {}).filter(
          (name) => typeof implementation.actions[name] === 'function',
        ),
        queries: Object.keys(implementation.queries ?? {}).filter(
          (name) => typeof implementation.queries[name] === 'function',
        ),
      };
    } else if (message.kind === 'measure') {
      result = Math.ceil(root.getBoundingClientRect().height + 24);
    } else if (message.kind === 'selection') {
      const active = document.activeElement;
      result =
        active && typeof active.selectionStart === 'number'
          ? active.value.slice(active.selectionStart, active.selectionEnd)
          : String(window.getSelection());
      result = result.slice(0, 4000);
    } else if (message.kind === 'describe') {
      result = await implementation.describe(structuredClone(message.props));
    } else {
      throw Error('Unknown widget operation');
    }
    parent.postMessage({ type: 'result', id: message.id, result }, '*');
  } catch (error) {
    parent.postMessage(
      { type: 'result', id: message.id, error: String(error.message || error).slice(0, 500) },
      '*',
    );
  }
});
const sizeObserver = new ResizeObserver(() => {
  parent.postMessage(
    { type: 'geometry', height: Math.ceil(root.getBoundingClientRect().height + 24) },
    '*',
  );
});
sizeObserver.observe(root);
window.addEventListener('pagehide', () => {
  chatSubscribers.clear();
  latestChat = { available: false, snapshot: null, error: '' };
  parent.postMessage({ type: 'chat-watch', watching: false }, '*');
  sizeObserver.disconnect();
  controller?.dispose?.();
});
parent.postMessage({ type: 'ready' }, '*');
