import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { companionMcpServerName } from './claude-transcript.ts';
import type { TurnResultConnection } from './turn-results.ts';

/** Environment variables through which the MCP bridge receives its per-turn connections. */
export const bridgeEnvironment = {
  resultsEndpoint: 'COMPANION_CLAUDE_RESULTS_ENDPOINT',
  resultsToken: 'COMPANION_CLAUDE_RESULTS_TOKEN',
  widgetEndpoint: 'COMPANION_WIDGET_ENDPOINT',
  widgetToken: 'COMPANION_WIDGET_TOKEN',
  sessionToolsEndpoint: 'COMPANION_SESSION_TOOLS_ENDPOINT',
  sessionToolsToken: 'COMPANION_SESSION_TOOLS_TOKEN',
  sessionToolsCapabilities: 'COMPANION_SESSION_TOOLS_CAPABILITIES',
} as const;

/** The connections one turn grants to its bridge. Widgets and session tools are optional leases. */
export interface BridgeConnections {
  results: TurnResultConnection;
  widgets?: { endpoint: string; token: string };
  sessionTools?: { endpoint: string; token: string; capabilities?: readonly string[] };
}

/** A written configuration file and the private directory that contains it. */
export interface McpConfigFile {
  path: string;
  /** Delete the directory. Safe to call repeatedly; failures are ignored. */
  remove(): Promise<void>;
}

/**
 * Write the per-turn `--mcp-config` file that starts Companion's stdio MCP
 * bridge (`mcp-server.ts`).
 *
 * The bearer tokens travel only in this file's `env` section, which Claude
 * Code passes to the bridge process. They are deliberately not placed in the
 * `claude` process environment, where the agent's own Bash tool could print
 * them into a transcript, nor on a command line, which other local users can
 * read. The file lives in a fresh 0700 directory with mode 0600, and the
 * backend removes it when the turn ends, after the tokens have expired anyway.
 *
 * The bridge is TypeScript, so it runs with the same Node executable and the
 * tsx loader that runs Companion itself. `alwaysLoad` stops Claude Code from
 * deferring the tools behind its ToolSearch tool, so the model sees them from
 * the start, as Pi's model sees its native tools (verified with 2.1.280).
 */
export async function writeMcpConfig(connections: BridgeConnections): Promise<McpConfigFile> {
  const directory = await mkdtemp(join(tmpdir(), 'companion-claude-'));
  const path = join(directory, 'mcp.json');

  const environment: Record<string, string> = {
    [bridgeEnvironment.resultsEndpoint]: connections.results.endpoint,
    [bridgeEnvironment.resultsToken]: connections.results.token,
  };
  if (connections.widgets) {
    environment[bridgeEnvironment.widgetEndpoint] = connections.widgets.endpoint;
    environment[bridgeEnvironment.widgetToken] = connections.widgets.token;
  }
  if (connections.sessionTools) {
    environment[bridgeEnvironment.sessionToolsEndpoint] = connections.sessionTools.endpoint;
    environment[bridgeEnvironment.sessionToolsToken] = connections.sessionTools.token;
    const capabilities = connections.sessionTools.capabilities ?? [];
    if (capabilities.length > 0) {
      environment[bridgeEnvironment.sessionToolsCapabilities] = capabilities.join(',');
    }
  }

  const configuration = {
    mcpServers: {
      [companionMcpServerName]: {
        type: 'stdio',
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), bridgeServerPath()],
        env: environment,
        alwaysLoad: true,
      },
    },
  };

  const remove = async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await writeFile(path, JSON.stringify(configuration, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await remove();
    throw error;
  }

  return { path, remove };
}

export function bridgeServerPath(): string {
  return fileURLToPath(new URL('./mcp-server.ts', import.meta.url));
}
