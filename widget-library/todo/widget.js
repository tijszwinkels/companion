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
    find(props, args.itemId).text = args.text;
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
  form.onsubmit = (event) => {
    event.preventDefault();
    const text = input.value.trim();
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
          message.textContent = 'Could not add this item. Your draft is still here; try again.';
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
      const present = new Set(props.items.map((item) => item.id));
      for (const [id, row] of rows) {
        if (!present.has(id)) {
          row.label.remove();
          rows.delete(id);
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
          draft.required = true;
          draft.setAttribute('aria-label', 'Edit item text');
          const save = document.createElement('button');
          save.type = 'submit';
          save.textContent = 'Save';
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          editor.append(draft, save, cancel);
          row = { label, checkbox, text, item };
          const current = row;
          let saving = false;
          const closeEditor = () => {
            editor.hidden = true;
            text.hidden = false;
            text.focus();
          };
          text.onclick = () => {
            draft.value = current.item.text;
            text.hidden = true;
            editor.hidden = false;
            draft.focus();
            draft.select();
          };
          cancel.onclick = closeEditor;
          editor.onkeydown = (event) => {
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
            if (saving) {
              return;
            }
            if (!value) {
              message.textContent = 'Item text cannot be empty.';
              draft.focus();
              return;
            }
            saving = true;
            draft.disabled = true;
            save.disabled = true;
            cancel.disabled = true;
            message.textContent = '';
            void api
              .call('rename_item', { itemId: current.item.id, text: value })
              .then(closeEditor)
              .catch(() => {
                message.textContent =
                  'Could not save this edit. Your draft is still here; try again.';
              })
              .finally(() => {
                saving = false;
                draft.disabled = false;
                save.disabled = false;
                cancel.disabled = false;
                if (!editor.hidden) {
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
                checkbox.checked = Boolean(current.item.completed);
                message.textContent = 'Could not save that change. Please try again.';
              })
              .finally(() => {
                checkbox.disabled = false;
              });
          };
          label.append(checkbox, text, editor);
          rows.set(item.id, row);
        }
        row.item = item;
        row.checkbox.checked = item.completed;
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
    },
  };
}
