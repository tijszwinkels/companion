export function describe(props) {
  const ids = new Set(props.items.map((item) => item.id));
  if (ids.size !== props.items.length) {
    throw Error('Todo item IDs must be distinct');
  }
  const description =
    `${props.title}: ${props.items.filter((item) => item.completed).length}/${props.items.length} complete.\n` +
    props.items.map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text}`).join('\n');
  return description.length <= 4000
    ? description
    : description.slice(0, 3950) + '\n… Additional items are available in the widget.';
}
function find(props, id) {
  const item = props.items.find((item) => item.id === id);
  if (!item) {
    throw Error('Todo item was not found');
  }
  return item;
}
export const actions = {
  add_item(props, args, context) {
    const itemId = context.requestId;
    props.items.push({ id: itemId, text: args.text, completed: false });
    return { props, result: { itemId } };
  },
  set_completed(props, args) {
    find(props, args.itemId).completed = args.completed;
    return { props };
  },
  rename_item(props, args) {
    const item = find(props, args.itemId);
    // Optional for existing action callers. New editors compare the item text,
    // independently of the host revision, to catch a rename during the save.
    if (args.expectedText !== undefined && item.text !== args.expectedText) {
      throw Error('This item changed. Review the saved text before replacing it.');
    }
    item.text = args.text;
    return { props };
  },
  remove_item(props, args) {
    find(props, args.itemId);
    props.items = props.items.filter((item) => item.id !== args.itemId);
    return { props };
  },
};
export function mount(root, api) {
  const card = document.createElement('section');
  card.className = 'todo-card';
  const header = document.createElement('header');
  header.className = 'todo-header';
  const heading = document.createElement('h2');
  const progress = document.createElement('span');
  progress.className = 'progress';
  const meter = document.createElement('div');
  meter.className = 'progress-track';
  meter.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  meter.append(fill);
  header.append(heading, progress);
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'A little space for what’s next.';
  const message = document.createElement('p');
  message.className = 'message';
  message.setAttribute('role', 'status');
  const list = document.createElement('div');
  list.className = 'todos';
  const rows = new Map();
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.placeholder = 'Add something to do…';
  input.setAttribute('aria-label', 'New todo');
  input.maxLength = 300;
  const button = document.createElement('button');
  button.textContent = '+';
  button.setAttribute('aria-label', 'Add item');
  button.type = 'submit';
  let adding = false;
  input.oninput = () => {
    message.textContent = '';
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text && !adding) {
      message.textContent = 'Item text cannot be empty.';
      input.focus();
    }
    if (text && !adding) {
      adding = true;
      button.disabled = true;
      message.textContent = '';
      void api
        .call('add_item', { text })
        .then(() => {
          if (input.value.trim() === text) {
            input.value = '';
          }
        })
        .catch(() => {
          message.textContent =
            'Could not add this item. Your draft is still here. Check the list before adding it again.';
        })
        .finally(() => {
          adding = false;
          button.disabled = false;
        });
    }
  };
  form.append(input, button);
  card.append(header, meter, form, message, empty, list);
  root.append(card);

  // Keep input nodes alive across remote updates and theme/zoom changes. A
  // user typing a new item must not lose their draft when the agent adds one.
  return {
    update(props) {
      // Scope typography to this card; keep host zoom and input drafts intact.
      card.style.setProperty('--todo-text-scale', String(props.textScale ?? 0.9));
      heading.textContent = props.title;
      const completed = props.items.filter((item) => item.completed).length;
      progress.textContent = `${completed} / ${props.items.length} done`;
      fill.style.width = `${props.items.length ? (completed / props.items.length) * 100 : 0}%`;
      empty.hidden = props.items.length > 0;
      // Moving an existing node with insertBefore can blur it in Chromium.
      // Restore only the previously focused control, including its selection.
      const active = document.activeElement;
      const selection =
        active && typeof active.selectionStart === 'number'
          ? [active.selectionStart, active.selectionEnd, active.selectionDirection]
          : null;
      const present = new Set(props.items.map((item) => item.id));
      for (const [id, row] of rows) {
        if (!present.has(id)) {
          if (!row.editor.hidden) {
            // Retain an orphaned editor as a copyable recovery draft. Never
            // redirect it into Add (which may already contain another draft).
            row.removed = true;
            row.checkbox.hidden = true;
            row.save.disabled = true;
            row.updateNotice();
          } else {
            const hadFocus = row.label.contains(active);
            row.label.remove();
            rows.delete(id);
            if (hadFocus) {
              input.focus();
            }
          }
        }
      }
      for (const [index, item] of props.items.entries()) {
        let row = rows.get(item.id);
        if (!row) {
          const label = document.createElement('div');
          label.className = 'todo-row';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'check-circle';
          const text = document.createElement('button');
          text.type = 'button';
          text.title = 'Edit item';
          const editor = document.createElement('form');
          editor.className = 'item-editor';
          editor.hidden = true;
          const draft = document.createElement('input');
          draft.maxLength = 300;
          draft.setAttribute('aria-label', 'Edit item text');
          const save = document.createElement('button');
          save.type = 'submit';
          save.textContent = 'Save';
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          const notice = document.createElement('p');
          notice.className = 'edit-notice';
          notice.setAttribute('role', 'status');
          editor.append(draft, save, cancel, notice);
          row = { label, checkbox, text, item, editor, save, removed: false };
          const current = row;
          let saving = false;
          let expectedText = item.text;
          let confirmedText = null;
          let editError = '';
          current.updateNotice = () => {
            const changed = current.item.text !== expectedText;
            if (confirmedText !== current.item.text) {
              confirmedText = null;
            }
            save.disabled = saving || current.removed;
            cancel.textContent = current.removed ? 'Dismiss' : 'Cancel';
            save.textContent = confirmedText === null ? 'Save' : 'Replace saved text';
            if (current.removed) {
              notice.textContent =
                'This item was removed. Your draft is kept here; copy it before dismissing.';
            } else if (changed && !editor.hidden) {
              notice.textContent =
                (editError ? editError + ' ' : '') +
                `Saved text changed to “${current.item.text}”. ` +
                (confirmedText === null
                  ? 'Your draft is unchanged. Save once to review the replacement, then confirm.'
                  : 'Press Replace saved text to replace that value with your draft, or Cancel to keep it.');
            } else {
              notice.textContent = editError;
            }
          };
          const closeEditor = () => {
            message.textContent = '';
            editError = '';
            if (current.removed) {
              label.remove();
              rows.delete(current.item.id);
              input.focus();
              return;
            }
            editor.hidden = true;
            text.hidden = false;
            text.focus();
          };
          text.onclick = () => {
            message.textContent = '';
            editError = '';
            expectedText = current.item.text;
            confirmedText = null;
            draft.value = expectedText;
            text.hidden = true;
            editor.hidden = false;
            current.updateNotice();
            draft.focus();
            draft.select();
          };
          draft.oninput = () => {
            message.textContent = '';
            editError = '';
            current.updateNotice();
          };
          cancel.onclick = closeEditor;
          editor.onkeydown = (event) => {
            // The sidebar host owns Escape; the pop-out delivers it here.
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (!saving) {
                closeEditor();
              }
            }
          };
          editor.onsubmit = (event) => {
            event.preventDefault();
            const value = draft.value.trim();
            if (saving || current.removed) {
              return;
            }
            if (!value) {
              editError = 'Item text cannot be empty.';
              current.updateNotice();
              draft.focus();
              return;
            }
            if (current.item.text !== expectedText && confirmedText !== current.item.text) {
              editError = '';
              confirmedText = current.item.text;
              current.updateNotice();
              draft.focus();
              return;
            }
            // Confirm only this item's saved text. Other rows, title, completion
            // and theme changes do not invalidate the user's editing baseline.
            const savedText = current.item.text;
            saving = true;
            draft.readOnly = true;
            save.disabled = true;
            cancel.disabled = true;
            message.textContent = '';
            editError = '';
            void api
              .call('rename_item', {
                itemId: current.item.id,
                text: value,
                expectedText: savedText,
              })
              .then(() => {
                if (!current.removed) {
                  closeEditor();
                }
              })
              .catch(() => {
                editError =
                  'Could not save this edit. Your draft is kept here. Check the saved text before retrying.';
              })
              .finally(() => {
                saving = false;
                draft.readOnly = false;
                save.disabled = current.removed;
                cancel.disabled = false;
                current.updateNotice();
                if (!editor.hidden && label.isConnected) {
                  draft.focus();
                }
              });
          };
          checkbox.onchange = () => {
            checkbox.disabled = true;
            message.textContent = '';
            void api
              .call('set_completed', { itemId: current.item.id, completed: checkbox.checked })
              .catch(() => {
                message.textContent = 'Could not save that change. Please try again.';
              })
              .finally(() => {
                // The viewer may deliver another writer's saved value before
                // this acknowledgement. Reconcile it when pending ends.
                checkbox.checked = Boolean(current.item.completed);
                checkbox.disabled = false;
              });
          };
          label.append(checkbox, text, editor);
          rows.set(item.id, row);
        }
        row.item = item;
        row.removed = false;
        row.checkbox.hidden = false;
        // Keep the user's optimistic state through unrelated prop updates.
        if (!row.checkbox.disabled) {
          row.checkbox.checked = item.completed;
        }
        row.updateNotice();
        row.text.setAttribute('aria-label', `Edit: ${item.text}`);
        row.checkbox.setAttribute(
          'aria-label',
          `${item.completed ? 'Reopen' : 'Complete'}: ${item.text}`,
        );
        row.text.textContent = item.text;
        row.text.className = item.completed ? 'item-text completed' : 'item-text';
        if (list.children[index] !== row.label) {
          list.insertBefore(row.label, list.children[index] || null);
        }
      }
      if (active && root.contains(active) && document.activeElement !== active) {
        active.focus({ preventScroll: true });
        if (selection) {
          active.setSelectionRange(...selection);
        }
      }
    },
  };
}
