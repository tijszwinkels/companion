/**
 * Entry point of Companion's MCP bridge. Claude Code starts this process from
 * the per-turn `--mcp-config` file written by `mcp-config.ts`, with the turn's
 * connections in its environment, and ends it when the turn's process exits.
 *
 * Only the connections present in the environment produce tools, mirroring
 * Pi's per-turn `--extension` selection. Without a result route the bridge
 * offers no Companion tools, because choices and names could not reach
 * Companion.
 *
 * The Pi-parity tools come from the opt-in `claude-tools.json` in the working
 * directory, which Claude Code gives the bridge: the agent directory. An
 * invalid file throws here, so the bridge exits and the turn fails visibly.
 */
import { parseSessionToolCapabilities } from '../session-tools.ts';
import { bridgeTools, type BridgeToolConnections } from './bridge-tools.ts';
import { bridgeEnvironment } from './mcp-config.ts';
import { bridgeInstructions, McpStdioServer } from './mcp-stdio.ts';
import { loadClaudeToolSettings } from './parity/settings.ts';

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
  sessionTools: sessionToolsConnection(),
};

/**
 * Session tools plus the optional tools the listener announced. A listener
 * that predates an optional tool announces nothing, so the bridge (loaded
 * fresh from disk each turn) never offers a tool that listener cannot serve.
 */
function sessionToolsConnection(): BridgeToolConnections['sessionTools'] {
  const lease = connection(
    bridgeEnvironment.sessionToolsEndpoint,
    bridgeEnvironment.sessionToolsToken,
  );
  if (!lease) {
    return undefined;
  }
  const capabilities = parseSessionToolCapabilities(
    process.env[bridgeEnvironment.sessionToolsCapabilities],
  );
  return { ...lease, capabilities };
}

const toolSettings = await loadClaudeToolSettings(process.cwd());
const tools = bridgeTools(connections, toolSettings);
const server = new McpStdioServer(tools, bridgeInstructions(tools), {
  input: process.stdin,
  write: (line) => {
    process.stdout.write(line);
  },
});

await server.serve();
process.exit(0);
