// Resident rows for continuous conversation scrolling (SessionView.qml).
//
// Pure functions without Qt objects, tested directly by
// test/panel/tst_history_rows.qml. The listener serves bounded pages of a
// conversation's append-only row list (src/agents/history-pages.ts). A page or
// the live recent window starts at a position {index, offset}; its k-th
// message is row `start.index + k`. `offset` counts UTF-16 units of
// `input + text` and is non-zero only inside a row too large for one page, which
// arrives as `historyFragment` pieces. Every resident row therefore knows its
// exact half-open range [start, end) in authoritative history.
//
// Contiguous ranges are what make continuous scrolling safe: joining pages only
// where one ends exactly where the next starts means no row is skipped or shown
// twice. Fragments of one oversized message are distinct rows with distinct
// keys (message ID plus fragment start).
//
// Everything resident in the transcript is bounded together: older rows plus
// the live recent window when they are joined to it never exceed three pages
// (600 rows, 196,608 text units). Trimming first spares the rows the reader can
// see; only if that cannot meet the bound are those trimmed too. Tool output
// is not part of this budget: tool groups are empty summary rows whose details
// load separately (ToolDetails.qml).

// Mirrors panelMessageLimit/panelTextLimit in src/agents/transcript-limits.ts:
// one page. The listener's own page and window limits are unchanged.
export const pageRows = 200;
export const pageUnits = 65536;
export const residentRows = 3 * pageRows;
export const residentUnits = 3 * pageUnits;

export function samePosition(left, right) {
  return left.index === right.index && left.offset === right.offset;
}

// Negative when `left` is earlier in history, positive when later.
export function comparePositions(left, right) {
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.offset - right.offset;
}

export function positionKey(position) {
  return position.index + ':' + position.offset;
}

function units(message) {
  return (message.input || '').length + (message.text || '').length;
}

// The key a transcript row keeps while it stays resident, including across
// live updates. Distinct fragments of one message have distinct keys.
export function rowKey(message) {
  return message.id + '@' + (message.historyFragment ? message.historyFragment.start : 0);
}

// Rows of a page or live window starting at `start`, in order. `revision` is the
// conversation revision the listener reported with them; later revisions mean
// the content may since have changed.
export function rowsFrom(messages, start, revision) {
  const rows = [];

  for (let position = 0; position < messages.length; position++) {
    const message = messages[position];
    const index = start.index + position;
    const fragment = message.historyFragment;
    const from = fragment ? fragment.start : 0;
    const partial = fragment !== undefined && fragment !== null && fragment.end < fragment.total;

    rows.push({
      key: rowKey(message),
      message: message,
      start: { index: index, offset: from },
      end: partial ? { index: index, offset: fragment.end } : { index: index + 1, offset: 0 },
      revision: revision,
    });
  }

  return rows;
}

export function sizeOf(rows) {
  let total = 0;
  for (const row of rows) {
    total += units(row.message);
  }
  return { rows: rows.length, units: total };
}

// Whether `rows`, plus `reserved` rows that cannot be trimmed (the attached
// live window), fit the resident bound.
export function withinBudget(rows, reserved) {
  const size = sizeOf(rows);
  const extra = reserved || { rows: 0, units: 0 };
  return size.rows + extra.rows <= residentRows && size.units + extra.units <= residentUnits;
}

// The leading part of a row, ending at `offset` inside it. The listener
// orders a message's units as input, then text; a fragment keeps that order.
// `total` is the message's full length when known.
function leadingPart(row, offset, total) {
  const message = row.message;
  const keep = offset - row.start.offset;
  const input = message.input || '';
  const text = message.text || '';
  const part = Object.assign({}, message, {
    input: input.slice(0, keep),
    text: text.slice(0, Math.max(0, keep - input.length)),
    historyFragment: { start: row.start.offset, end: offset, total: total },
  });

  return {
    key: row.key,
    message: part,
    start: row.start,
    end: { index: row.start.index, offset: offset },
    revision: row.revision,
  };
}

// The rows strictly before `position`, for joining older rows to a live window
// that starts there. A row spanning the position is shortened to its leading
// part, so the join neither repeats nor drops text.
//
// A row loaded earlier may since have grown (a streamed or rewritten message):
// it then ends short of a position inside that row. Such a row is kept as an
// explicit fragment ending where its loaded text really ends, and the result
// is not `complete`: the caller must not join it to the live window, but can
// load the missing text from that end. `total` is the row's current length
// when known (from the live window), for its fragment label.
export function rowsBefore(rows, position, total) {
  const kept = [];

  for (const row of rows) {
    if (comparePositions(row.end, position) <= 0) {
      kept.push(row);
      continue;
    }
    if (comparePositions(row.start, position) >= 0) {
      break;
    }

    // The row spans `position`, which lies inside row `position.index`.
    const loadedEnd = row.start.offset + units(row.message);
    const known = row.message.historyFragment ? row.message.historyFragment.total : loadedEnd;
    const length = total || Math.max(known, position.offset);
    if (loadedEnd >= position.offset) {
      kept.push(leadingPart(row, position.offset, length));
      return { rows: kept, complete: true };
    }
    if (loadedEnd > row.start.offset) {
      kept.push(leadingPart(row, loadedEnd, length));
    }
    return { rows: kept, complete: false };
  }

  return { rows: kept, complete: true };
}

// Remove rows from one side ("start" or "end") until they, plus `reserved`
// (see withinBudget), fit the resident bound. Rows whose keys are in
// `protectedKeys` (what the reader can see) and everything beyond them are kept
// if possible; when that still exceeds the bound, they are trimmed as well, so
// the bound always holds. Returns the remaining rows.
export function trimmed(rows, side, protectedKeys, reserved) {
  const extra = reserved || { rows: 0, units: 0 };
  const size = sizeOf(rows);
  let first = 0;
  let last = rows.length;
  let count = size.rows + extra.rows;
  let total = size.units + extra.units;

  for (const spareVisible of [true, false]) {
    while (last - first > 0 && (count > residentRows || total > residentUnits)) {
      const position = side === 'start' ? first : last - 1;
      const row = rows[position];
      if (spareVisible && protectedKeys[row.key] === true) {
        break;
      }
      count--;
      total -= units(row.message);
      if (side === 'start') {
        first++;
      } else {
        last--;
      }
    }
  }

  return rows.slice(first, last);
}
