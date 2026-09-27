import QtQuick

// Bounded reconnect pages + live completion/feedback events. Row revisions
// prevent a delayed page from undoing a feedback click received in between.
QtObject {
  id: root
  property string sessionId: ""
  property bool available: false
  property bool loading: false
  property bool synced: false
  // Keep content-free tombstones across reconnects. A page requested before
  // deletion must not put the deleted transcript back into the list.
  property var deletedIds: ({})
  property ListModel model: ListModel {}
  signal pageRequested(var request)

  function reset(id) {
    root.model.clear();
    root.deletedIds = ({});
    root.sessionId = id;
    root.loading = false;
    root.synced = false;
  }

  function observe(id, count) {
    root.available = typeof id === "string" && id !== "";
    if (!root.available) {
      if (root.sessionId)
        root.reset("");
      return;
    }
    if (id !== root.sessionId)
      root.reset(id);
    if (!root.loading && !root.synced) {
      root.loading = true;
      root.pageRequested({
        action: "activity-history",
        sessionId: id,
        after: 0,
        through: count
      });
    }
  }

  function disconnected() {
    root.loading = false;
    root.synced = false;
  }

  function upsert(entry) {
    if (root.deletedIds[entry.id])
      return;
    const row = {
      entryId: entry.id,
      sequence: entry.sequence,
      revision: entry.revision,
      utterance: entry.utterance,
      intent: entry.intent || "",
      outcome: entry.outcome,
      observedAt: entry.observedAt,
      feedback: entry.correct === true ? "correct" : entry.correct === false ? "incorrect" : "",
      actualIntent: entry.actualIntent || "",
      // Transcription cleanup; empty strings when it was off or unknown.
      cleanedText: entry.cleanedText || "",
      cleanupStatus: entry.cleanupStatus || "",
      cleanupFallback: entry.cleanupFallback || "",
      // "earlier-attempt" when the text came from an earlier attempt of a
      // continued utterance, "audio-only" when there is no text; empty when
      // unspecified.
      transcriptSource: entry.transcriptSource || ""
    };
    // New completions normally insert at zero; feedback/pages locate their
    // stable sequence by binary search without scanning the whole session.
    let left = 0;
    let right = root.model.count;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (root.model.get(middle).sequence > row.sequence)
        left = middle + 1;
      else
        right = middle;
    }
    if (left < root.model.count && root.model.get(left).sequence === row.sequence) {
      if (root.model.get(left).revision < row.revision)
        root.model.set(left, row);
    } else
      root.model.insert(left, row);
  }

  function update(id, entry) {
    if (id !== root.sessionId)
      return;
    root.upsert(entry);
  }

  function remove(id, entry) {
    if (id !== root.sessionId || !entry)
      return;
    root.deletedIds[entry.id] = true;
    for (let index = 0; index < root.model.count; index++) {
      if (root.model.get(index).entryId === entry.id) {
        root.model.remove(index);
        break;
      }
    }
  }

  function page(result) {
    if (result.sessionId !== root.sessionId)
      return;
    for (const entry of result.removed || [])
      root.remove(result.sessionId, entry);
    for (const entry of result.entries)
      root.upsert(entry);
    if (result.next !== null) {
      root.pageRequested({
        action: "activity-history",
        sessionId: root.sessionId,
        after: result.next,
        through: result.through
      });
    } else {
      root.loading = false;
      root.synced = true;
    }
  }
}
