/**
 * Entry point of Companion's MCP bridge. Claude Code starts this process from
 * the per-turn `--mcp-config` file written by `mcp-config.ts`, with the turn's
 * connections in its environment, and ends it when the turn's process exits.
 *
 * Only the connections present in the environment produce tools, mirroring
 * Pi's per-turn `--extension` selection. Without a result route the bridge
 * offers nothing, because choices and names could not reach Companion.
 */
import { bridgeTools, type BridgeToolConnections } from './bridge-tools.ts';
import { bridgeEnvironment } from './mcp-config.ts';
import { bridgeInstructions, McpStdioServer } from './mcp-stdio.ts';

function connection(
  endpointVariable: string,
  tokenVariable: string,
): { endpoint: string; token: string } | undefined {
  const endpoint = process.env[endpointVariable];
  const token = process.env[tokenVariable];
  if (!endpoint || !token) {
    return undefined;
  }

  return { endpoint, token };
}

const connections: BridgeToolConnections = {
  results: connection(bridgeEnvironment.resultsEndpoint, bridgeEnvironment.resultsToken),
  widgets: connection(bridgeEnvironment.widgetEndpoint, bridgeEnvironment.widgetToken),
  sessionTools: connection(
    bridgeEnvironment.sessionToolsEndpoint,
    bridgeEnvironment.sessionToolsToken,
  ),
};

const tools = bridgeTools(connections);
const server = new McpStdioServer(tools, bridgeInstructions(tools), {
  input: process.stdin,
  write: (line) => {
    process.stdout.write(line);
  },
});

await server.serve();
process.exit(0);
