/**
 * The selected conversation's pinned widget (integrations/shell/README.md,
 * "Pinned widgets"), in one of its two places:
 *
 * - `top`: a band above the chat, below the bar, a percentage of the area
 *   below the bar high (pinned-place.ts), with a draggable lower edge, and
 *   in its header Fold, → Right (in a wide enough window), Auto (while a
 *   place is fixed) and Unpin;
 * - `right`: the right column (Workspace.tsx gives it the Activity column's
 *   width and puts Activity below it when shown), with ↑ Top, Auto and Unpin.
 *
 * The frame, its sandbox, its states and its visibility are the inline
 * widget's (../widgets/InlineWidget.tsx, `WidgetFrame` in its `pinned`
 * mode). A change of place draws it in another part of the page, so its
 * frame loads again there.
 */

import { Divider } from '../layout/Divider.tsx';
import {
  bandMaximumPercent,
  bandMinimum,
  bandChatMinimum,
  bandMinimumPercent,
  bandPercentFromKey,
  bandPercentFromPointer,
  placeChoices,
  type PinnedPlace,
  type PinnedPlacePreference,
} from '../layout/pinned-place.ts';
import { WidgetFrame, type InlineWidgetEnvironment } from '../widgets/InlineWidget.tsx';
import type { PinnedWidget as Pinned } from '../widgets/pinned-widget.ts';

/** The pinned widget's element, named by the band's lower edge (`aria-controls`). */
export const pinnedWidgetId = 'pinned-widget';

/** What each place button says and does. */
const placeButtons: Record<PinnedPlacePreference, { text: string; title: string }> = {
  right: { text: '→ Right', title: 'Keep the pinned widget at the right in this browser' },
  top: { text: '↑ Top', title: 'Keep the pinned widget above the chat in this browser' },
  auto: { text: 'Auto', title: "Place the pinned widget by the window's shape again" },
};

export function PinnedWidgetPanel(props: {
  pinned: Pinned;
  place: PinnedPlace;
  /** The place this browser fixed, or 'auto'. */
  preference: PinnedPlacePreference;
  windowWidth: number;
  onPlace: (preference: PinnedPlacePreference) => void;
  /** The band's height in percent (top only). */
  percent: number;
  onPercent: (percent: number, remember: boolean) => void;
  onRememberPercent: () => void;
  folded: boolean;
  onFolded: (folded: boolean) => void;
  environment: InlineWidgetEnvironment;
}) {
  const { pinned, place } = props;
  const folded = place === 'top' && props.folded;

  const controls = [];
  if (place === 'top') {
    let foldText = '▾ Fold';
    let foldLabel = 'Fold the pinned widget to its header';
    if (folded) {
      foldText = '▸ Show';
      foldLabel = 'Show the pinned widget';
    }
    controls.push(
      <button
        key="fold"
        class="panel-action small inline-widget-action"
        aria-expanded={!folded}
        aria-controls={pinnedWidgetId}
        aria-label={foldLabel}
        title={foldLabel}
        onClick={() => props.onFolded(!folded)}
      >
        {foldText}
      </button>,
    );
  }
  for (const choice of placeChoices(place, props.preference, props.windowWidth)) {
    const button = placeButtons[choice];
    controls.push(
      <button
        key={choice}
        class="panel-action small inline-widget-action"
        title={button.title}
        onClick={() => props.onPlace(choice)}
      >
        {button.text}
      </button>,
    );
  }

  const frame = (
    <WidgetFrame
      key={pinned.address}
      mode="pinned"
      name={pinned.name}
      time=""
      address={pinned.address}
      environment={props.environment}
      controls={controls}
      folded={folded}
    />
  );

  if (place === 'right') {
    return (
      <section id={pinnedWidgetId} class="pinned-side" aria-label={`Pinned widget ${pinned.name}`}>
        {frame}
      </section>
    );
  }

  // The band's height is the rule's (pinned-place.ts `bandHeight`), in CSS
  // so it follows the area below the bar without measuring it: the
  // percentage, at most the area less the chat's minimum, never under the
  // band's minimum (clamp() gives the minimum where the two disagree).
  let style: Record<string, string> = {
    height: `clamp(${bandMinimum}px, ${props.percent}%, calc(100% - ${bandChatMinimum}px))`,
  };
  if (folded) {
    style = {};
  }

  return (
    <>
      <section
        id={pinnedWidgetId}
        class="pinned-band"
        style={style}
        aria-label={`Pinned widget ${pinned.name}`}
      >
        {frame}
      </section>
      {!folded && (
        <Divider
          orientation="horizontal"
          width={props.percent}
          narrowest={bandMinimumPercent}
          widest={bandMaximumPercent}
          label="Pinned widget height"
          title="Drag to change the height of the pinned widget"
          valueText={`${props.percent} percent of the chat's height`}
          controls={pinnedWidgetId}
          fromPointer={(clientY, container) =>
            bandPercentFromPointer(clientY - container.top, container.height)
          }
          fromKey={bandPercentFromKey}
          onWidth={props.onPercent}
          onRemember={props.onRememberPercent}
        />
      )}
    </>
  );
}
