export function describe(props) {
  const description =
    props.title +
    ': ' +
    props.options.map((option) => option.title + ': ' + option.points.join(', ')).join('; ');
  return description.length <= 4000
    ? description
    : description.slice(0, 3950) + '\n… Additional details are available in the widget.';
}
export const actions = {};
export function mount(root) {
  return {
    update(props) {
      const heading = document.createElement('h2');
      heading.textContent = props.title;
      const options = document.createElement('div');
      options.className = 'options';
      for (const option of props.options) {
        const card = document.createElement('section');
        const title = document.createElement('h3');
        title.textContent = option.title;
        const list = document.createElement('ul');
        for (const point of option.points) {
          const item = document.createElement('li');
          item.textContent = point;
          list.append(item);
        }
        card.append(title, list);
        options.append(card);
      }
      root.replaceChildren(heading, options);
    },
  };
}
