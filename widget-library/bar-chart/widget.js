export function describe(props) {
  if (props.labels.length !== props.values.length) {
    throw Error('Labels and values must have the same length');
  }
  const description =
    props.title +
    ': ' +
    props.labels.map((label, index) => `${label}: ${props.values[index]} ${props.unit}`).join('; ');
  return description.length <= 4000
    ? description
    : description.slice(0, 3950) + '\n… Additional values are available in the widget.';
}
export const actions = {
  append_point(props, args) {
    props.labels.push(args.label);
    props.values.push(args.value);
    return { props, result: { index: props.values.length - 1 } };
  },
};
export function mount(root) {
  return {
    update(props) {
      const title = document.createElement('h2');
      title.textContent = props.title;
      root.replaceChildren(title);
      const maximum = Math.max(1, ...props.values);
      for (let index = 0; index < props.labels.length; index++) {
        const row = document.createElement('div');
        row.className = 'bar-row';
        const label = document.createElement('span');
        label.textContent = props.labels[index];
        const track = document.createElement('div');
        track.className = 'track';
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.width = `${(props.values[index] / maximum) * 100}%`;
        track.append(bar);
        const value = document.createElement('span');
        value.textContent = `${props.values[index]} ${props.unit}`;
        row.title = `${props.labels[index]}: ${value.textContent}`;
        row.append(label, track, value);
        root.append(row);
      }
    },
  };
}
