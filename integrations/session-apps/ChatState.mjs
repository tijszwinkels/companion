// What the trusted HTML chat page receives from its native view.
//
// Pure functions without Qt objects, used by ChatBridge.qml and tested
// directly by test/session-apps-ui/chat-state.test.ts.
//
// The conversation itself stays in the QML SessionView model: its resident
// transcript rows (live window plus loaded older pages), the host-owned draft,
// pending send/choice and recording. The HTML page is a view of that model.
// It receives:
// - `rows` messages: the resident rows in order, sending only rows whose
//   content changed since the previous message. A streamed answer therefore
//   costs one row per update, not the whole transcript.
// - `status` messages: the small composer/controls state, sent whole.
//
// Every message carries a sequence number. A page that sees a gap, or has
// just (re)loaded, asks for a full resynchronization instead of guessing.

// Bound on one serialized bridge message. Resident rows are already bounded
// by HistoryRows (three pages of 65,536 text units); this only stops a broken
// caller from sending something unbounded into the page.
export const maximumMessageCharacters = 2 * 1024 * 1024;

// One transcript row as the page renders it. Built from SessionView.rowData()
// so both views show exactly the same resident rows. Tool inputs are not
// copied: tool details load separately and remain in the classic view.
export function chatRow(data) {
  let widget = null;
  if (data.widgetJson) {
    try {
      const parsed = JSON.parse(data.widgetJson);
      widget = { name: typeof parsed.name === 'string' ? parsed.name : 'Widget' };
    } catch (error) {
      widget = { name: 'Widget' };
    }
  }

  let origin = null;
  if (data.fromAppMessage) {
    // Already checked/derived by SessionView.rowData; no authored body heuristic.
    origin = {
      kind: 'application-message',
      title: data.originTitle || 'unverified application origin',
      receiptId: data.originReceiptId || '',
      sessionId: '',
      groupId: '',
    };
  } else if (data.fromApplication) {
    // The person's own committed app edits, delivered by the host.
    origin = { kind: 'application-event', title: '', sessionId: '', groupId: '' };
  } else if (data.fromAgent) {
    let kind = 'agent';
    if (data.fromWake) {
      kind = 'scheduled-wake';
    } else if (data.fromExternal) {
      kind = 'external';
    }
    origin = {
      kind: kind,
      title: data.originTitle || '',
      sessionId: data.originSessionId || '',
      groupId: data.originGroupId || '',
    };
  }

  return {
    key: data.rowKey,
    id: data.messageId,
    kind: data.kind,
    text: data.body || '',
    state: data.state || '',
    toolName: data.toolName || '',
    toolCount: data.toolCount || 0,
    toolUnavailable: data.toolUnavailable === true,
    screenshot: data.screenshot === true,
    screenshotAvailable: data.screenshot === true && data.screenshotUrl !== '',
    screenshotNotSaved: data.screenshotNotSaved === true,
    fragmentLabel: data.fragmentLabel || '',
    origin: origin,
    widget: widget,
  };
}

// Compare `rows` (chatRow objects, in display order) with what was sent
// before. `sent` maps row key -> serialized row and is replaced, not mutated.
// Returns the new order, the rows to (re)send and the next `sent` map.
export function diffRows(sent, rows, full) {
  const next = {};
  const changed = [];
  const order = [];

  for (const row of rows) {
    const encoded = JSON.stringify(row);
    order.push(row.key);
    next[row.key] = encoded;

    if (full || sent[row.key] !== encoded) {
      changed.push(row);
    }
  }

  return { order: order, changed: changed, sent: next };
}

// Whether a draft edit from the page may replace the host draft. The page
// sends the host draft revision its text was based on. Host-side changes
// (agent drafts, recording, a completed send, a handover, another tab)
// advance that revision; the page's own accepted edits do not, so several
// edits in flight in order are all accepted. An edit based on an older
// revision would overwrite a change the page has not seen, and is refused.
export function draftEditAllowed(edit, displayedId, revision, maximumCharacters) {
  if (!edit || typeof edit.text !== 'string' || typeof edit.sessionId !== 'string') {
    return { allowed: false, reason: 'invalid' };
  }
  if (edit.sessionId === '' || edit.sessionId !== displayedId) {
    return { allowed: false, reason: 'other-session' };
  }
  if (edit.base !== revision) {
    return { allowed: false, reason: 'stale' };
  }
  if (edit.text.length > maximumCharacters) {
    return { allowed: false, reason: 'too-long' };
  }
  return { allowed: true, reason: '' };
}
