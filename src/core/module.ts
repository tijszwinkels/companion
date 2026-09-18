/**
 * The small public view of a module that the graph inspector needs. Modules
 * still expose and call their ordinary methods; this interface does not start,
 * stop, schedule, or wrap them. Dependencies are the actual objects being used.
 */
export interface InspectableModule {
  /** Unique within one application graph; independent of the display label. */
  readonly id: string;
  readonly label: string;

  readonly dependencies: Readonly<Record<string, InspectableModule>>;

  /** Routers expose a snapshot derived from their actual registration tables. */
  readonly processors?: ReadonlyMap<string, RegisteredProcessor>;
}

/**
 * Inspection data for one registered route. Keep the real processor reference
 * so shared objects have one graph identity. Prefixes come from the router's
 * validated prefix table, which can differ from the original spelling.
 */
export interface RegisteredProcessor {
  readonly processor: InspectableModule;
  readonly prefixes: readonly string[];
  readonly llmEligible: boolean;
}
