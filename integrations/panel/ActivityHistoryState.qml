import QtQuick

// Bounded reconnect pages + live completion/feedback events. Row revisions
// prevent a delayed page from undoing a feedback click received in between.
QtObject {
  id: root
  property string sessionId: ""
  property bool available: false
  property bool loading: false
  property bool synced: false
  property ListModel model: ListModel {}
  signal pageRequested(var request)

  function reset(id) {
    root.model.clear();
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
    const row = {
      entryId: entry.id,
      sequence: entry.sequence,
      revision: entry.revision,
      utterance: entry.utterance,
      intent: entry.intent || "",
      outcome: entry.outcome,
      observedAt: entry.observedAt,
      feedback: entry.correct === true ? "correct" : entry.correct === false ? "incorrect" : "",
      actualIntent: entry.actualIntent || ""
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

  function page(result) {
    if (result.sessionId !== root.sessionId)
      return;
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
