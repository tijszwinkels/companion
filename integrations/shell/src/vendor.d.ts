/**
 * Types for the plain ES modules the browser shell shares with the Qt host.
 * Those modules have no declarations of their own because QML imports them
 * directly; these describe exactly the functions the shell calls.
 */

/** Resident transcript rows for history paging (integrations/panel/HistoryRows.mjs). */
declare module '*/panel/HistoryRows.mjs' {
  type AgentMessage = import('../../../src/agents/types.ts').AgentMessage;
  type HistoryPosition = import('../../../src/agents/history-pages.ts').HistoryPosition;

  /** One resident row: a message and its exact range in authoritative history. */
  export interface HistoryRow {
    key: string;
    message: AgentMessage;
    /** Null only for listeners without paging (no `history` window). */
    start: HistoryPosition | null;
    end: HistoryPosition | null;
    revision: number;
    /** True for rows of the live window, which keep updating. */
    live?: boolean;
  }

  /** A position-carrying row, as returned by `rowsFrom`. */
  export interface PositionedRow extends HistoryRow {
    start: HistoryPosition;
    end: HistoryPosition;
  }

  export interface RowsSize {
    rows: number;
    units: number;
  }

  export const pageRows: number;
  export const pageUnits: number;
  export const residentRows: number;
  export const residentUnits: number;

  export function samePosition(left: HistoryPosition, right: HistoryPosition): boolean;
  export function comparePositions(left: HistoryPosition, right: HistoryPosition): number;
  export function positionKey(position: HistoryPosition): string;
  export function rowKey(message: AgentMessage): string;
  export function rowsFrom(
    messages: AgentMessage[],
    start: HistoryPosition,
    revision: number,
  ): PositionedRow[];
  export function sizeOf(rows: HistoryRow[]): RowsSize;
  export function withinBudget(rows: HistoryRow[], reserved?: RowsSize): boolean;
  export function rowsBefore(
    rows: PositionedRow[],
    position: HistoryPosition,
    total: number,
  ): { rows: PositionedRow[]; complete: boolean };
  export function trimmed<Row extends HistoryRow>(
    rows: Row[],
    side: 'start' | 'end',
    protectedKeys: Record<string, boolean>,
    reserved?: RowsSize,
  ): Row[];
}

/** The trusted chat page's row projection (integrations/session-apps/ChatState.mjs). */
declare module '*/session-apps/ChatState.mjs' {
  type ChatRow = import('../../session-apps/chat/protocol.ts').ChatRow;

  export const maximumMessageCharacters: number;
  export function chatRow(data: Record<string, unknown>): ChatRow;
  export function diffRows(
    sent: Record<string, string>,
    rows: ChatRow[],
    full: boolean,
  ): { order: string[]; changed: ChatRow[]; sent: Record<string, string> };
}
