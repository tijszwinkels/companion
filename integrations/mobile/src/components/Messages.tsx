/**
 * Conversation message rendering: user/assistant/notice bubbles, collapsed
 * tool groups with the lazy paged reader, authenticated screenshots and
 * widget placeholders.
 */

import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { AgentMessage } from '../../../../src/agents/types.ts';
import type { ToolPage } from '../../../../src/remote/protocol.ts';
import { gatewayUrl } from '../connection.ts';
import { copyText } from '../format.ts';
import { useStore } from '../hooks.ts';
import { renderMarkdown } from '../markdown.ts';
import { ChevronIcon, CloseIcon, ToolIcon } from './icons.tsx';
import { Modal } from './Modal.tsx';

/**
 * Props are the message plus the two session fields tool pages need, so a
 * streamed update to one bubble does not re-render every other bubble.
 */
export const Message = memo(function Message(props: {
  message: AgentMessage;
  sessionId: string;
  toolEpoch: string;
}) {
  const { message } = props;

  if (message.kind === 'tool') {
    return <ToolGroup message={message} sessionId={props.sessionId} toolEpoch={props.toolEpoch} />;
  }

  if (message.kind === 'notice') {
    return (
      <div class={`message notice ${message.state === 'error' ? 'error' : ''}`} role="note">
        {message.text}
      </div>
    );
  }

  if (message.kind === 'user') {
    return <UserMessage message={message} />;
  }

  return <AssistantMessage message={message} />;
});

function UserMessage(props: { message: AgentMessage }) {
  const { message } = props;
  const origin = message.origin;

  let from = '';
  let fromClass = 'from';
  if (origin?.kind === 'agent') {
    from = `From ${origin.title}`;
  } else if (origin?.kind === 'external') {
    from = `${origin.title} · external (unverified)`;
    fromClass = 'from external';
  }

  const classes = ['message', 'user'];
  if (message.state === 'queued') {
    classes.push('queued');
  }
  if (origin) {
    classes.push('origin');
  }

  return (
    <div class={classes.join(' ')}>
      {from && <div class={fromClass}>{from}</div>}
      {message.screenshot && <Screenshot url={message.screenshotUrl} />}
      {message.text && <div class="bubble">{message.text}</div>}
      {message.state === 'queued' && <div class="state-note">Queued · sends after this answer</div>}
      {message.state === 'error' && <div class="state-note">Not delivered</div>}
    </div>
  );
}

function AssistantMessage(props: { message: AgentMessage }) {
  const { message } = props;
  const [copied, setCopied] = useState(false);

  if (message.widget) {
    return (
      <div class="message assistant">
        <div class="widget-card">
          <strong>{message.widget.name}</strong> widget
          <div>Interactive widgets open on the computer’s panel for now.</div>
          {message.text && <div style={{ marginTop: '6px' }}>{message.text}</div>}
        </div>
      </div>
    );
  }

  const classes = `message assistant ${message.state === 'error' ? 'error' : ''}`;

  return (
    <div class={classes}>
      <div
        class="bubble markdown"
        // renderMarkdown escapes all HTML in agent text; see markdown.ts.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text || '…') }}
      />
      {message.text && message.state !== 'running' && (
        <div class="message-actions">
          <button
            onClick={async () => {
              setCopied(await copyText(message.text));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Screenshots -----------------------------------------------------------

/** Fetch with the device token (images cannot send headers by themselves). */
function Screenshot(props: { url?: string }) {
  const store = useStore();
  const [objectUrl, setObjectUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    if (!props.url) {
      return;
    }

    let revoked = false;
    let created = '';
    const controller = new AbortController();

    fetch(gatewayUrl(props.url, store.connection.server), {
      headers: { Authorization: `Bearer ${store.connection.token}` },
      credentials: 'omit',
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw Error(String(response.status));
        }
        return response.blob();
      })
      .then((blob) => {
        if (!revoked) {
          created = URL.createObjectURL(blob);
          setObjectUrl(created);
        }
      })
      .catch(() => {
        if (!revoked) {
          setFailed(true);
        }
      });

    return () => {
      revoked = true;
      controller.abort();
      if (created) {
        URL.revokeObjectURL(created);
      }
    };
  }, [props.url]);

  return (
    <>
      <button
        class="screenshot-thumb"
        onClick={() => objectUrl && setViewing(true)}
        aria-label="Enlarge attached screenshot"
        disabled={!objectUrl}
      >
        {objectUrl ? (
          <img src={objectUrl} alt="Screenshot attached to this question" />
        ) : (
          <span class="placeholder">
            {failed || !props.url ? 'Screenshot unavailable' : 'Loading…'}
          </span>
        )}
      </button>
      {viewing && (
        <Modal className="viewer" title="Screenshot" onClose={() => setViewing(false)}>
          {(dismiss) => (
            <>
              <div class="viewer-bar">
                <button class="icon-button" onClick={dismiss} aria-label="Close screenshot">
                  <CloseIcon />
                </button>
              </div>
              <div class="viewer-image">
                <img src={objectUrl} alt="Screenshot attached to this question" />
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

// ---- Tool groups -------------------------------------------------------------

interface LoadedPage {
  index: number;
  offset: number;
  groupRevision: string;
  page: ToolPage;
}

/**
 * Consecutive tool calls, collapsed. Expanding reads bounded pages on demand
 * (agent-tool-page); nothing is fetched while collapsed or while streaming.
 * A newer group revision marks the page as older without replacing it.
 */
function ToolGroup(props: { message: AgentMessage; sessionId: string; toolEpoch: string }) {
  const store = useStore();
  const { message, sessionId, toolEpoch } = props;
  const group = message.toolGroup;
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<LoadedPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);

  const count = group?.count ?? 1;
  const running = message.state === 'running';
  const label = `${count} tool ${count === 1 ? 'call' : 'calls'}${running ? ' · running' : ''}`;

  async function load(
    index: number,
    offset: number,
    callRevision?: string,
    revision = group?.revision ?? '',
  ) {
    if (!group || !toolEpoch) {
      setError('Details are not available for this conversation.');
      return;
    }

    const current = ++generation.current;
    setLoading(true);
    setError('');

    try {
      const page = (await store.request(
        'agent-tool-page',
        {
          id: sessionId,
          epoch: toolEpoch,
          groupId: message.id,
          revision,
          ...(callRevision ? { callRevision } : {}),
          index,
          offset,
        },
        { quiet: true },
      )) as ToolPage;

      if (current === generation.current) {
        setLoaded({ index, offset, groupRevision: revision, page });
      }
    } catch (failure) {
      if (current === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (current === generation.current) {
        setLoading(false);
      }
    }
  }

  function toggle() {
    if (open) {
      // Collapsing discards the page; delayed replies are ignored.
      generation.current++;
      setOpen(false);
      setLoaded(undefined);
      setError('');
      return;
    }
    setOpen(true);
    void load(0, 0);
  }

  const stale = loaded && group && loaded.groupRevision !== group.revision;

  return (
    <div class="tool-group" data-open={open}>
      <button onClick={toggle} aria-expanded={open}>
        <ToolIcon size={18} />
        <span style={{ flex: 1 }}>{label}</span>
        <span class="chevron" aria-hidden="true">
          <ChevronIcon size={18} />
        </span>
      </button>
      {open && (
        <div class="tool-page">
          {stale && <div class="stale">These tools have updated since this page loaded.</div>}
          {loading && !loaded && <div class="hint">Loading…</div>}
          {error && (
            <div class="composer-note error" role="alert">
              {error}
            </div>
          )}
          {loaded && <pre>{loaded.page.text}</pre>}
          <div class="tool-controls">
            {loaded?.page.next && (
              <button
                class="button small"
                disabled={loading}
                onClick={() =>
                  load(
                    loaded.page.next!.index,
                    loaded.page.next!.offset,
                    loaded.page.next!.index === loaded.index ? loaded.page.callRevision : undefined,
                    loaded.page.next!.index === loaded.index ? loaded.groupRevision : undefined,
                  )
                }
              >
                Next page
              </button>
            )}
            {loaded && (loaded.index > 0 || loaded.offset > 0) && (
              <button class="button small" disabled={loading} onClick={() => load(0, 0)}>
                From start
              </button>
            )}
            {(stale || error) && (
              <button
                class="button small"
                disabled={loading}
                onClick={() => load(loaded?.index ?? 0, loaded?.offset ?? 0)}
              >
                Refresh
              </button>
            )}
            {loaded && (
              <button
                class="button small"
                onClick={async () => {
                  setCopied(await copyText(loaded.page.text));
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? 'Copied' : 'Copy page'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
