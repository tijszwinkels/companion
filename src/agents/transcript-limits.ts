// One display-history count for live updates, saved snapshots and recovery from
// canonical widget state. This limit is independent of the model's context size.
export const panelMessageLimit = 4_000;

// Ordinary display text/input, measured using JavaScript string length (UTF-16
// code units). Tool groups occupy one row and carry no input/output text here.
// Share this budget between streamed messages and widget admission.
export const panelTextLimit = 1_000_000;
