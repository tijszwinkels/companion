// This entire module runs in an opaque-origin sandbox. It has no Node APIs,
// credentials, network permissions or access to the surrounding application.
const implementation = await import(window.widgetModuleUrl);
const root = document.getElementById('widget');
const pendingActions = new Map();
let nextAction = 0;
let controller;
const api = {
  call(action, args = {}) {
    if (pendingActions.size >= 8) {
      return Promise.reject(Error('Widget actions are busy'));
    }
    return new Promise((resolve, reject) => {
      const id = `user-${++nextAction}`;
      pendingActions.set(id, { resolve, reject });
      parent.postMessage({ type: 'action', id, action, args }, '*');
    });
  },
};

window.addEventListener('message', async (event) => {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') {
    return;
  }
  const message = event.data;
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
      const theme = message.theme;
      for (const name of ['foreground', 'background', 'accent', 'muted']) {
        document.documentElement.style.setProperty('--' + name, theme[name]);
      }
      document.documentElement.style.fontSize = `${16 * theme.scale}px`;
      controller ??= implementation.mount(root, api);
      await controller.update(structuredClone(message.props));
      result = true;
    } else if (message.kind === 'reduce') {
      const action = implementation.actions?.[message.action];
      if (typeof action !== 'function') {
        throw Error('Widget action is not implemented');
      }
      result = await action(structuredClone(message.props), structuredClone(message.args), {
        requestId: message.requestId,
      });
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
window.addEventListener('pagehide', () => controller?.dispose?.());
parent.postMessage({ type: 'ready' }, '*');
