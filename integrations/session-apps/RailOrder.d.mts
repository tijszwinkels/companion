// Types for RailOrder.mjs (shared by the rail page and TrustedRailView.qml).

export declare const dragThreshold: number;
export declare const scrollEdgeUnits: number;
export declare const scrollStepUnits: number;

export declare function insertionTarget(
  rows: readonly { id: string; top: number; height: number }[],
  draggedId: string,
  y: number,
): string;

export declare function isNoOp(
  ids: readonly string[],
  draggedId: string,
  beforeId: string,
): boolean;

export declare function orderKey(ids: readonly string[], revision: string): string;

export declare function moveAllowed(
  state: { ids: string[]; canMove: boolean; online: boolean; orderRevision: string } | null,
  id: unknown,
  beforeId: unknown,
  revision: unknown,
): boolean;
