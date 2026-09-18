import type { Graph, GraphEdge } from './graph.ts';

/** Escape text as Mermaid numeric entities rather than accepting diagram syntax. */
function escapeLabel(value: string): string {
  return value.replace(/[^\p{L}\p{N} _.,:/()+-]/gu, (character) => `#${character.codePointAt(0)};`);
}

function edgeLabel(edge: GraphEdge): string {
  if (!edge.selection) {
    return edge.label;
  }

  const alternatives: string[] = [];

  if (edge.selection.prefixes.length) {
    alternatives.push(`prefix: ${edge.selection.prefixes.join(' / ')} + payload`);
  }

  if (edge.selection.llmEligible) {
    alternatives.push(`no prefix + LLM: ${edge.label}`);
  }

  return alternatives.length ? alternatives.join(' OR ') : edge.label;
}

/** Render exported data; generated node identifiers keep module IDs out of syntax. */
export function graphToMermaid(graph: Graph): string {
  const identifiers = new Map<string, string>();
  const lines = ['flowchart LR'];

  for (const [index, node] of graph.nodes.entries()) {
    // Graphs may also come from saved or edited JSON. Do not silently move an
    // edge to the last of two different nodes claiming the same identity.
    if (identifiers.has(node.id)) {
      throw Error(`Graph contains a duplicate module ID: ${node.id}`);
    }

    const identifier = `module${index}`;
    identifiers.set(node.id, identifier);
    lines.push(`  ${identifier}["${escapeLabel(node.label)}"]`);
  }

  for (const edge of graph.edges) {
    const from = identifiers.get(edge.from);
    const to = identifiers.get(edge.to);

    if (!from || !to) {
      throw Error('Graph edge references an unknown module');
    }

    // Dotted edges are conditional processor dispatch; solid edges are named
    // dependencies. Neither arrow style implies scheduling or concurrent work.
    const arrow = edge.kind === 'route' ? '-.->' : '-->';
    lines.push(`  ${from} ${arrow}|"${escapeLabel(edgeLabel(edge))}"| ${to}`);
  }

  return lines.join('\n') + '\n';
}
