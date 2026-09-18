import type { InspectableModule } from './module.ts';

export interface GraphNode {
  id: string;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  kind: 'dependency' | 'route';
  selection?: {
    prefixes: string[];
    llmEligible: boolean;
  };
}

/**
 * A serializable snapshot of reachable modules and their connections. Arrows
 * point from caller to dependency or selected processor; replies return on the
 * same call. This describes possible connections, not an execution trace.
 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Read named dependencies and registrations without running any module. */
export function createGraph(root: InspectableModule): Graph {
  const graph: Graph = { nodes: [], edges: [] };
  const visited = new Map<string, InspectableModule>();

  function visit(module: InspectableModule): void {
    const previous = visited.get(module.id);

    if (previous) {
      if (previous !== module) {
        throw Error(`Duplicate module ID: ${module.id}`);
      }

      return;
    }

    if (!module.id.trim() || !module.label.trim()) {
      throw Error('Module ID and label must not be blank');
    }

    // Record identity before following edges so shared dependencies and cycles
    // are safe. Read only inspection fields, never arbitrary object properties
    // such as configuration, credentials, prompts, or in-flight payloads.
    visited.set(module.id, module);
    graph.nodes.push({ id: module.id, label: module.label });

    for (const [name, dependency] of Object.entries(module.dependencies)) {
      graph.edges.push({
        from: module.id,
        to: dependency.id,
        label: name,
        kind: 'dependency',
      });

      visit(dependency);
    }

    const processors = module.processors;

    if (processors) {
      for (const [name, registration] of processors) {
        graph.edges.push({
          from: module.id,
          to: registration.processor.id,
          label: name,
          kind: 'route',
          selection: {
            prefixes: [...registration.prefixes],
            llmEligible: registration.llmEligible,
          },
        });

        visit(registration.processor);
      }
    }
  }

  visit(root);

  return graph;
}
