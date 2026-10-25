// Session application: tasks as cards in three columns.
//
// Same state as task-list ({ title, tasks: [{ id, text, column }] }), so the
// agent can switch between the two bundles while keeping every task. Adds
// drag and drop between columns, inline renaming and a get_task query.

const columns = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];

export function describe(state) {
  const parts = columns.map(({ id, label }) => {
    const tasks = state.tasks.filter((task) => task.column === id);
    return `${label} (${tasks.length})${tasks.length ? ': ' : ''}${tasks.map((task) => task.text).join('; ')}`;
  });
  const text = `${state.title} board. ${parts.join('. ')}.`;
  return text.length <= 4000 ? text : text.slice(0, 3950) + '… More cards are on the board.';
}

function find(state, id) {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) {
    throw Error('Task was not found');
  }
  return task;
}

export const actions = {
  add_task(state, args, context) {
    const taskId = context.requestId.slice(-64);
    state.tasks.push({ id: taskId, text: args.text, column: args.column ?? 'todo' });
    return { state, result: { taskId } };
  },
  move_task(state, args) {
    const task = find(state, args.id);
    if (args.before === args.id) {
      throw Error('A task cannot be placed before itself');
    }
    state.tasks = state.tasks.filter((entry) => entry !== task);
    task.column = args.column;
    const before = args.before ? state.tasks.findIndex((entry) => entry.id === args.before) : -1;
    state.tasks.splice(before >= 0 ? before : state.tasks.length, 0, task);
    return { state };
  },
  complete_task(state, args) {
    find(state, args.id).column = 'done';
    return { state };
  },
  remove_task(state, args) {
    find(state, args.id);
    state.tasks = state.tasks.filter((entry) => entry.id !== args.id);
    return { state };
  },
  rename_task(state, args) {
    find(state, args.id).text = args.text;
    return { state };
  },
};

export const queries = {
  list_tasks(state, args) {
    return {
      tasks: args.column ? state.tasks.filter((task) => task.column === args.column) : state.tasks,
    };
  },
  summary(state) {
    const result = { todo: 0, doing: 0, done: 0, total: state.tasks.length };
    for (const task of state.tasks) {
      result[task.column]++;
    }
    return result;
  },
  get_task(state, args) {
    return { task: find(state, args.id) };
  },
};

export function mount(root, api) {
  const board = document.createElement('main');
  board.className = 'task-board';
  const title = document.createElement('h1');
  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('role', 'status');
  const lanes = document.createElement('div');
  lanes.className = 'lanes';
  board.append(title, lanes, status);
  root.append(board);

  // Inline editors survive re-renders: an unsaved rename keeps its text.
  const drafts = new Map();

  function act(name, args) {
    status.textContent = '';
    return api.call(name, args).catch((error) => {
      status.textContent = error.message;
    });
  }

  const lists = new Map();
  for (const column of columns) {
    const lane = document.createElement('section');
    lane.className = 'lane';
    lane.dataset.column = column.id;
    const heading = document.createElement('h2');
    heading.textContent = column.label;
    const list = document.createElement('ol');
    lane.append(heading, list);

    lane.addEventListener('dragover', (event) => {
      event.preventDefault();
      lane.classList.add('target');
    });
    lane.addEventListener('dragleave', () => lane.classList.remove('target'));
    lane.addEventListener('drop', (event) => {
      event.preventDefault();
      lane.classList.remove('target');
      const id = event.dataTransfer.getData('text/plain');
      const card = event.target.closest?.('li[data-id]');
      const before = card && card.dataset.id !== id ? card.dataset.id : undefined;
      if (id) {
        // One drop is one semantic edit: a single targeted move action.
        void act('move_task', { id, column: column.id, ...(before ? { before } : {}) });
      }
    });

    if (column.id === 'todo') {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.placeholder = 'New card';
      input.maxLength = 500;
      input.setAttribute('aria-label', 'New card');
      form.append(input);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (text) {
          void act('add_task', { text }).then(() => {
            input.value = '';
          });
        }
      });
      lane.append(form);
    }

    lists.set(column.id, list);
    lanes.append(lane);
  }

  function card(task) {
    const item = document.createElement('li');
    item.dataset.id = task.id;
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', task.id);
    });

    const text = document.createElement('div');
    text.className = 'text';
    if (drafts.has(task.id)) {
      const editor = document.createElement('input');
      editor.value = drafts.get(task.id);
      editor.addEventListener('input', () => drafts.set(task.id, editor.value));
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && editor.value.trim()) {
          void act('rename_task', { id: task.id, text: editor.value.trim() }).then(() => {
            drafts.delete(task.id);
          });
        } else if (event.key === 'Escape') {
          drafts.delete(task.id);
          editor.blur();
          void api.state.read().then(({ data }) => render(data));
        }
      });
      text.append(editor);
    } else {
      text.textContent = task.text;
      text.title = 'Double-click to rename';
      text.addEventListener('dblclick', () => {
        drafts.set(task.id, task.text);
        void api.state.read().then(({ data }) => render(data));
      });
    }

    const controls = document.createElement('div');
    controls.className = 'controls';
    const index = columns.findIndex((column) => column.id === task.column);
    for (const [label, target] of [
      ['←', columns[index - 1]],
      ['→', columns[index + 1]],
    ]) {
      if (target) {
        const button = document.createElement('button');
        button.textContent = label;
        button.setAttribute('aria-label', `Move to ${target.label}`);
        button.addEventListener(
          'click',
          () => void act('move_task', { id: task.id, column: target.id }),
        );
        controls.append(button);
      }
    }
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Delete card');
    remove.addEventListener('click', () => void act('remove_task', { id: task.id }));
    controls.append(remove);

    item.append(text, controls);
    return item;
  }

  function render(state) {
    title.textContent = state.title;
    for (const [id, list] of lists) {
      list.replaceChildren(...state.tasks.filter((task) => task.column === id).map(card));
    }
    for (const id of drafts.keys()) {
      if (!state.tasks.some((task) => task.id === id)) {
        drafts.delete(id);
      }
    }
  }

  return {
    update(state) {
      render(state);
    },
    dispose() {
      drafts.clear();
    },
  };
}
