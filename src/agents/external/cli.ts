import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ExternalTransportError, requestExternal } from './client.ts';
import { externalSocketPath } from './paths.ts';

const help = `Usage: companion-session <info|list|start|reopen|close|send|draft> [options]
  --socket PATH           Override COMPANION_EXTERNAL_SOCKET or the runtime default
  --label NAME            Unverified caller label (required except info/list)
  --id UUID               Companion conversation from list (reopen/close/send/draft)
  --text TEXT             Message or draft, 1–4000 characters
  --profile PROFILE       coding (default) or quickQuestion, for start
  --harness HARNESS       pi or claude-code, for start (default: configured coding harness)
  --model MODEL           Explicit model for start: Pi provider/id or Claude model ID
  --focus                 Explicitly reveal a started/reopened/drafted conversation
  --append                Append draft below existing text; default refuses overwrite
  --query TEXT --limit N  Saved title filter and count (1–50) for list
  --request-id ID          Explicit retry of the SAME request, within 10 minutes
  --timeout-ms N          Client deadline, 1–60000 (default 20000)
  --help                  Show this help

Listener opt-in: npm start -- --external-sessions [--external-socket PATH]
Default: $XDG_RUNTIME_DIR/companion-external/session.sock. Linux, same OS user.
JSON stdout; exits: 0 success, 2 usage, 3 unavailable/unsafe, 4 refusal,
5 ambiguous outcome. Request ID is emitted on stderr before sending mutations.
No automatic retries. Lost response/cancellation may follow a committed action.
Reuse the exact ID and arguments to retrieve its receipt; never blindly create
another mutation. Restarted listeners and expired IDs refuse replay.`;

let requestId: string | undefined;
let method: string | undefined;
let mutationExchange = false;
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      socket: { type: 'string' },
      label: { type: 'string' },
      id: { type: 'string' },
      text: { type: 'string' },
      profile: { type: 'string' },
      harness: { type: 'string' },
      model: { type: 'string' },
      focus: { type: 'boolean' },
      append: { type: 'boolean' },
      query: { type: 'string' },
      limit: { type: 'string' },
      'request-id': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
  } else if (
    process.env.COMPANION_INTERNAL_AGENT !== undefined ||
    process.env.COMPANION_SESSION_TOOLS_TOKEN !== undefined ||
    process.env.COMPANION_WIDGET_TOKEN !== undefined
  ) {
    console.log(
      JSON.stringify({
        ok: false,
        code: 'internal-caller',
        error:
          'Use the internal Companion session tools in a Companion agent turn; the external CLI would bypass its turn guards.',
      }),
    );
    process.exitCode = 4;
  } else {
    method = positionals[0];
    if (
      positionals.length !== 1 ||
      !['info', 'list', 'start', 'reopen', 'close', 'send', 'draft'].includes(method)
    ) {
      throw Error('Choose one command; see --help');
    }
    if (method !== 'info' && method !== 'list' && !values.label) {
      throw Error('--label is required for mutations');
    }
    const timeout = Number(values['timeout-ms'] ?? 20000);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) {
      throw Error('--timeout-ms must be 1–60000');
    }
    const path = externalSocketPath(values.socket);
    let result: Record<string, unknown>;
    if (method === 'info') {
      result = await requestExternal(path, { method }, controller.signal, timeout);
    } else {
      requestId = values['request-id'];
      if (!requestId) {
        const info = await requestExternal(path, { method: 'info' }, controller.signal, timeout);
        if (info.ok !== true || typeof info.epoch !== 'string') {
          throw new ExternalTransportError(false);
        }
        requestId = `${info.epoch}_${Date.now()}_${randomUUID()}`;
      }
      const command: Record<string, unknown> = { method, requestId, label: values.label ?? 'CLI' };
      for (const key of ['id', 'text', 'profile', 'harness', 'model', 'focus', 'query'] as const) {
        if (values[key] !== undefined) {
          command[key] = values[key];
        }
      }
      if (values.limit !== undefined) {
        command.limit = Number(values.limit);
      }
      if (values.append) {
        command.ifDraftExists = 'append';
      }
      if (method !== 'list') {
        console.error(JSON.stringify({ requestId }));
      }
      mutationExchange = method !== 'list';
      result = await requestExternal(path, command, controller.signal, timeout);
    }
    console.log(JSON.stringify(result));
    process.exitCode = result.ok === true ? 0 : result.code === 'unconfirmed' ? 5 : 4;
  }
} catch (error) {
  const transport = error instanceof ExternalTransportError;
  const ambiguous = transport && error.ambiguous && mutationExchange;
  console.log(
    JSON.stringify({
      ok: false,
      code: ambiguous ? 'unconfirmed' : transport ? 'unavailable' : 'usage',
      error:
        transport && !mutationExchange
          ? 'Discovery/read connection unavailable; no mutation was sent'
          : error instanceof Error
            ? error.message.slice(0, 600)
            : 'Request failed',
      requestId,
    }),
  );
  process.exitCode = ambiguous ? 5 : transport ? 3 : 2;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
