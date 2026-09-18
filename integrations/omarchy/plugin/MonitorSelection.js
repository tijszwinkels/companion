// Linux connector names identify the usual built-in laptop panels. Prefer an
// external display even when the keyboard focus remains on the laptop screen.
// Coordinates and widths are logical pixels, so mixed DPI layouts compare in
// the same coordinate system. A name tie-break keeps mirrored layouts stable.
function chooseScreen(screens) {
  const external = screens.filter((screen) => !/^(eDP|LVDS|DSI)(-|$)/i.test(screen.name));
  const candidates = external.length > 0 ? external : screens;
  let chosen = null;

  for (const candidate of candidates) {
    const rightEdge = candidate.x + candidate.width;
    const chosenRightEdge = chosen ? chosen.x + chosen.width : -Infinity;

    if (
      !chosen ||
      rightEdge > chosenRightEdge ||
      (rightEdge === chosenRightEdge && candidate.name < chosen.name)
    ) {
      chosen = candidate;
    }
  }

  return chosen;
}
