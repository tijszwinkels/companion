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
  const heading = document.createElement('h2');
  const list = document.createElement('div');
  list.className = 'todos';
  const rows = new Map();
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.placeholder = 'Add an item';
  input.setAttribute('aria-label', 'New todo');
  input.maxLength = 300;
  const button = document.createElement('button');
  button.textContent = 'Add';
  button.type = 'submit';
  form.onsubmit = (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text) {
      void api
        .call('add_item', { text })
        .then(() => {
          if (input.value.trim() === text) {
            input.value = '';
          }
        })
        .catch(() => {});
    }
  };
  form.append(input, button);
  root.append(heading, list, form);

  // Keep input nodes alive across remote updates and theme/zoom changes. A
  // user typing a new item must not lose their draft when the agent adds one.
  return {
    update(props) {
      heading.textContent = props.title;
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
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          const text = document.createElement('span');
          row = { label, checkbox, text, item };
          const current = row;
          checkbox.onchange = () => {
            void api
              .call('set_completed', { itemId: current.item.id, completed: checkbox.checked })
              .catch(() => {
                checkbox.checked = current.item.completed;
              });
          };
          label.append(checkbox, text);
          rows.set(item.id, row);
        }
        row.item = item;
        row.checkbox.checked = item.completed;
        row.text.textContent = item.text;
        row.text.className = item.completed ? 'completed' : '';
        if (list.children[index] !== row.label) {
          list.insertBefore(row.label, list.children[index] || null);
        }
      }
    },
  };
}
