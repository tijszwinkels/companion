// Session application: tasks as one list grouped by status.
//
// State: { title, tasks: [{ id, text, column: 'todo' | 'doing' | 'done' }] }.
// The task-board bundle uses the same state, so the agent can replace this
// code with the board (or back) without losing tasks.

const columns = ['todo', 'doing', 'done'];
const labels = { todo: 'To do', doing: 'Doing', done: 'Done' };

export function describe(state) {
  const lines = [`${state.title}: ${state.tasks.length} tasks.`];
  for (const column of columns) {
    const tasks = state.tasks.filter((task) => task.column === column);
    if (tasks.length) {
      lines.push(`${labels[column]}: ${tasks.map((task) => task.text).join('; ')}`);
    }
  }
  const text = lines.join('\n');
  return text.length <= 4000 ? text : text.slice(0, 3950) + '\n… More tasks are in the list.';
}

function find(state, id) {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) {
    throw Error('Task was not found');
  }
  return task;
}

// Reducers: deterministic, no DOM access. The request ID gives a stable new
// task ID when a failed request is retried.
export const actions = {
  add_task(state, args, context) {
    const taskId = context.requestId.slice(-64);
    state.tasks.push({ id: taskId, text: args.text, column: args.column ?? 'todo' });
    return { state, result: { taskId } };
  },
  move_task(state, args) {
    const task = find(state, args.id);
    state.tasks = state.tasks.filter((entry) => entry !== task);
    task.column = args.column;
    let index = state.tasks.length;
    if (args.before) {
      const before = state.tasks.findIndex((entry) => entry.id === args.before);
      if (before >= 0) {
        index = before;
      }
    }
    state.tasks.splice(index, 0, task);
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
};

// Queries read a cloned snapshot. Anything they change is discarded.
export const queries = {
  list_tasks(state, args) {
    const tasks = args.column
      ? state.tasks.filter((task) => task.column === args.column)
      : state.tasks;
    return { tasks };
  },
  summary(state) {
    const counts = { todo: 0, doing: 0, done: 0 };
    for (const task of state.tasks) {
      counts[task.column]++;
    }
    return { ...counts, total: state.tasks.length };
  },
};

export function mount(root, api) {
  const page = document.createElement('main');
  page.className = 'task-list';

  const heading = document.createElement('h1');
  const counter = document.createElement('p');
  counter.className = 'counter';

  const form = document.createElement('form');
  const input = document.createElement('input');
  input.placeholder = 'Add a task';
  input.maxLength = 500;
  input.setAttribute('aria-label', 'New task');
  const add = document.createElement('button');
  add.type = 'submit';
  add.textContent = 'Add';
  form.append(input, add);

  const list = document.createElement('ul');
  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('role', 'status');

  page.append(heading, counter, form, list, status);
  root.append(page);

  // Failures are shown, never retried automatically: a reported failure may
  // follow a committed write, so the user checks the list first.
  function run(promise) {
    status.textContent = '';
    return promise.catch((error) => {
      status.textContent = error.message;
      throw error;
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    void run(api.call('add_task', { text })).then(
      () => {
        input.value = '';
      },
      () => {},
    );
  });

  // The summary comes from the application's own query, demonstrating that
  // the view can use the same typed read path as the agent.
  function refreshCounter() {
    void api
      .query('summary', {})
      .then(({ result }) => {
        counter.textContent = `${result.done} of ${result.total} done`;
      })
      .catch(() => {
        counter.textContent = '';
      });
  }

  function render(state) {
    heading.textContent = state.title;
    list.replaceChildren();
    for (const column of columns) {
      for (const task of state.tasks.filter((entry) => entry.column === column)) {
        const item = document.createElement('li');
        item.dataset.column = task.column;
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = task.column === 'done';
        check.setAttribute('aria-label', `Done: ${task.text}`);
        check.addEventListener('change', () => {
          const target = check.checked ? 'done' : 'todo';
          void run(api.call('move_task', { id: task.id, column: target })).catch(() => {
            check.checked = !check.checked;
          });
        });
        const text = document.createElement('span');
        text.textContent = task.text;
        const badge = document.createElement('small');
        badge.textContent = labels[task.column];
        item.append(check, text, badge);
        list.append(item);
      }
    }
  }

  const unsubscribe = api.state.subscribe(() => refreshCounter());

  return {
    update(state) {
      render(state);
    },
    dispose() {
      unsubscribe();
    },
  };
}
