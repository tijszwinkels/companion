// Address rules for the in-panel browser (PanelBrowser.qml).
//
// Pure functions without Qt objects, tested directly by
// test/panel/tst_panel_browser_policy.qml. They rely on the URL class of
// QML's JavaScript engine, which is backed by QUrl rather than a WHATWG
// parser. Input is text typed by the user or a URL string Chromium is about
// to load in the top-level frame; output is a plain decision object.
//
// The panel browser is an ordinary web page viewer, not a way to reach
// Companion's own capabilities. Top-level pages may therefore use:
//   - https: on any host (normal TLS; certificate errors are never bypassed),
//   - http: only on this computer's loopback addresses, for explicitly local
//     development apps and test fixtures,
//   - about:blank, which Chromium uses for empty documents.
// Everything else (file:, data:, blob:, javascript:, companion-widget:,
// chrome:, view-source:, mailto: and other external schemes) is refused. The
// same rule applies to typed addresses, clicked links, form submissions and
// server redirects, because PanelBrowser checks every main-frame navigation.
// Subresources and subframes keep Chromium's normal same-origin and
// mixed-content rules; this module does not police them.

// Loopback hosts as reported by a URL parser. "localhost" and its subdomains
// always resolve to loopback in Chromium; IPv4 127.0.0.0/8 and IPv6 ::1 are the
// loopback ranges. The parser has already canonicalized shorthand forms such as
// 127.1 or 0x7f.1 to 127.0.0.1. QML's URL (backed by QUrl) reports IPv6 hosts
// without brackets, WHATWG parsers with them; accept both spellings.
export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  if (host === '::1' || host === '[::1]') {
    return true;
  }

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function parse(text) {
  try {
    return new URL(text);
  } catch (error) {
    return null;
  }
}

// Decide whether the top-level frame may show this URL.
// Returns {allowed: true} or {allowed: false, reason: "<user-facing text>"}.
export function mainFrameDecision(urlText) {
  const text = String(urlText || '');

  if (text === 'about:blank') {
    return { allowed: true, reason: '' };
  }

  const url = parse(text);

  const web = url !== null && (url.protocol === 'https:' || url.protocol === 'http:');

  if (url === null || (web && url.hostname === '')) {
    return { allowed: false, reason: 'That is not a valid web address.' };
  }

  if (url.protocol === 'https:') {
    return { allowed: true, reason: '' };
  }

  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
    return { allowed: true, reason: '' };
  }

  if (url.protocol === 'http:') {
    return {
      allowed: false,
      reason: 'Plain http:// is only opened for this computer (localhost). Use https://.',
    };
  }

  const scheme = url.protocol.replace(/:$/, '');

  return {
    allowed: false,
    reason: 'The panel browser does not open ' + scheme + ': addresses.',
  };
}

// Anything that starts like "scheme:" but is not "host:port".
function hasExplicitScheme(text) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return false;
  }

  const hostWithPort = /^[^:/?#]+:\d+(?:[/?#]|$)/;

  return !hostWithPort.test(text);
}

// Turn typed address-bar text into a URL to load.
// Returns {url: "<absolute URL>", error: ""} or {url: "", error: "<text>"}.
// Bare names get https://, except loopback hosts, which get http:// because
// local development servers rarely have certificates. There is no search
// engine: text with spaces is rejected rather than sent to a third party.
export function addressFromInput(input) {
  const text = String(input || '').trim();

  if (text === '') {
    return { url: '', error: 'Enter a web address.' };
  }

  if (/\s/.test(text)) {
    return { url: '', error: 'Web addresses cannot contain spaces.' };
  }

  let candidate = text;

  if (!hasExplicitScheme(text)) {
    const hostPart = text.split(/[/?#]/)[0];
    const bareHost = parse('http://' + hostPart);
    const local = bareHost !== null && isLoopbackHost(bareHost.hostname);

    candidate = (local ? 'http://' : 'https://') + text;
  }

  const url = parse(candidate);

  if (url === null) {
    return { url: '', error: 'That is not a valid web address.' };
  }

  const decision = mainFrameDecision(url.href);

  if (!decision.allowed) {
    return { url: '', error: decision.reason };
  }

  return { url: url.href, error: '' };
}

// Short site label for the status strip: host (with a non-default port) for
// web pages, empty for about:blank or unparseable text. QML's URL keeps an
// explicit default port, so drop it here rather than show "example.com:443".
export function displayHost(urlText) {
  const url = parse(String(urlText || ''));

  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return '';
  }

  const defaultPort = url.protocol === 'https:' ? '443' : '80';

  if (url.port === '' || url.port === defaultPort) {
    return url.hostname;
  }

  return url.host;
}
