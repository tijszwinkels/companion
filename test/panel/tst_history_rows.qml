import QtQuick
import QtTest
import "../../integrations/panel/HistoryRows.mjs" as HistoryRows

// Pure resident-row arithmetic for continuous scrolling (HistoryRows.mjs).
TestCase {
  name: "CompanionHistoryRows"

  function message(id, text, input, fragment) {
    const value = {id: id, kind: "assistant", text: text, input: input || ""}
    if (fragment) value.historyFragment = fragment
    return value
  }

  function test_positions_and_keys_follow_rows_and_fragments() {
    const rows = HistoryRows.rowsFrom([
      message("a", "tail", "", {start: 6, end: 10, total: 10}),
      message("b", "whole"),
      message("c", "head", "", {start: 0, end: 4, total: 9}),
    ], {index: 7, offset: 6}, 3)
    compare(rows.map(row => row.key).join(","), "a@6,b@0,c@0")
    compare(JSON.stringify(rows.map(row => [row.start, row.end])), JSON.stringify([
      [{index: 7, offset: 6}, {index: 8, offset: 0}],
      [{index: 8, offset: 0}, {index: 9, offset: 0}],
      [{index: 9, offset: 0}, {index: 9, offset: 4}],
    ]))
    verify(rows.every(row => row.revision === 3))
    verify(HistoryRows.comparePositions({index: 9, offset: 0}, {index: 8, offset: 99}) > 0)
    verify(HistoryRows.comparePositions({index: 9, offset: 1}, {index: 9, offset: 4}) < 0)
    compare(HistoryRows.positionKey({index: 9, offset: 4}), "9:4")
  }

  function test_rows_before_shortens_a_spanning_fragment_without_losing_units() {
    // Units of a row are input first, then text: "INPUT" + "abcdefghij".
    const rows = HistoryRows.rowsFrom([message("x", "abcdefghij", "INPUT"), message("y", "next")], {index: 4, offset: 0}, 1)
    const cut = HistoryRows.rowsBefore(rows, {index: 4, offset: 8})
    compare(cut.length, 1)
    compare(cut[0].message.input, "INPUT")
    compare(cut[0].message.text, "abc")
    compare(JSON.stringify(cut[0].message.historyFragment), JSON.stringify({start: 0, end: 8, total: 15}))
    compare(JSON.stringify(cut[0].end), JSON.stringify({index: 4, offset: 8}))
    compare(cut[0].key, "x@0")
    const insideInput = HistoryRows.rowsBefore(rows, {index: 4, offset: 3})
    compare(insideInput[0].message.input, "INP")
    compare(insideInput[0].message.text, "")
    // Row boundaries keep whole rows and stop before the boundary.
    compare(HistoryRows.rowsBefore(rows, {index: 5, offset: 0}).map(row => row.key).join(","), "x@0")
    compare(HistoryRows.rowsBefore(rows, {index: 4, offset: 0}).length, 0)
    // A later fragment of an already-fragmented row keeps its own start.
    const later = HistoryRows.rowsFrom([message("z", "klmnop", "", {start: 10, end: 16, total: 30})], {index: 2, offset: 10}, 1)
    const part = HistoryRows.rowsBefore(later, {index: 2, offset: 13})
    compare(part[0].message.text, "klm")
    compare(JSON.stringify(part[0].message.historyFragment), JSON.stringify({start: 10, end: 13, total: 30}))
  }

  function test_trimming_spares_visible_rows_until_the_hard_bound() {
    const many = []
    for (let index = 0; index < 700; index++) many.push(message("m" + index, "t"))
    const rows = HistoryRows.rowsFrom(many, {index: 0, offset: 0}, 1)
    const end = HistoryRows.trimmed(rows, "end", {}, {rows: 0, units: 0})
    compare(end.length, HistoryRows.residentRows)
    compare(end[0].key, "m0@0")
    const start = HistoryRows.trimmed(rows, "start", {}, {rows: 150, units: 0})
    compare(start.length, HistoryRows.residentRows - 150, "Attached live rows count toward the bound")
    compare(start[start.length - 1].key, "m699@0")
    // Visible rows are spared when the bound can be met without them...
    const spared = HistoryRows.trimmed(rows.slice(0, 650), "start", {"m60@0": true}, {rows: 0, units: 0})
    compare(spared.length, 600)
    compare(spared[0].key, "m50@0")
    // ...and give way only when it cannot: the bound always holds.
    const forced = HistoryRows.trimmed(rows.slice(0, 650), "start", {"m10@0": true}, {rows: 0, units: 0})
    compare(forced.length, HistoryRows.residentRows)
    compare(forced[0].key, "m50@0")
    verify(HistoryRows.withinBudget(forced))
    verify(!HistoryRows.withinBudget(rows))
    // Text is bounded too.
    const big = HistoryRows.rowsFrom([message("b1", "x".repeat(100000)), message("b2", "y".repeat(100000)), message("b3", "z".repeat(10))], {index: 0, offset: 0}, 1)
    const text = HistoryRows.trimmed(big, "start", {}, {rows: 0, units: 0})
    compare(text.map(row => row.key).join(","), "b2@0,b3@0")
    verify(HistoryRows.sizeOf(text).units <= HistoryRows.residentUnits)
  }
}
