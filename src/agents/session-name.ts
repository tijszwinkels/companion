/** Shared validation for the native tool and its result on Pi's RPC stream. */
export function parseSessionName(value: unknown): string {
  if (typeof value !== 'string') {
    throw Error('The session name must be a short text title');
  }

  const title = value.trim();
  // Count Unicode code points so an emoji does not consume two characters.
  // Reject line breaks/control characters; titles must fit a single tab label.
  if (!title || [...title].length > 40 || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(title)) {
    throw Error('Use a session name of 1–40 characters on one line');
  }

  return title;
}
