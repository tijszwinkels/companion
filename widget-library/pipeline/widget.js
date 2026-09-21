export function describe(props) {
  if (props.active >= props.steps.length) {
    throw Error('Active stage is outside this pipeline');
  }
  return (
    props.title +
    ': ' +
    props.steps.join(' → ') +
    (props.active >= 0 ? `. Active: ${props.steps[props.active]}` : '')
  );
}
export const actions = {
  set_active(props, args) {
    props.active = args.index;
    return { props };
  },
};
export function mount(root, api) {
  return {
    update(props) {
      const heading = document.createElement('h2');
      heading.textContent = props.title;
      const steps = document.createElement('div');
      steps.className = 'steps';
      props.steps.forEach((step, index) => {
        if (index) {
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          arrow.setAttribute('viewBox', '0 0 24 24');
          arrow.setAttribute('width', '24');
          arrow.setAttribute('height', '24');
          arrow.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M3 12h17m-7-7 7 7-7 7');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', 'currentColor');
          path.setAttribute('stroke-width', '2');
          arrow.append(path);
          steps.append(arrow);
        }
        const button = document.createElement('button');
        button.textContent = step;
        button.className = index === props.active ? 'active' : '';
        button.onclick = () => {
          void api.call('set_active', { index }).catch(() => {});
        };
        steps.append(button);
      });
      root.replaceChildren(heading, steps);
    },
  };
}
