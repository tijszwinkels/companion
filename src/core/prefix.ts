/**
 * Remove one literal command prefix, returning undefined when it does not match.
 * An empty string is a match with no payload, which the router must consume.
 */
export function stripPrefix(utterance: string, prefix: string): string | undefined {
  const text = utterance.trimStart();

  if (text.slice(0, prefix.length).toLowerCase() !== prefix) {
    return undefined;
  }

  const remainder = text.slice(prefix.length);

  // Require a word boundary: "entering" and "enter.txt" are ordinary speech.
  // ASR may insert punctuation after a command, as in "Insert, hello".
  // Consume only the separator so "insert .gitignore" keeps the leading dot.
  const separator = remainder.match(/^(?:\s+|[,:;.!?](?:\s+|$)|$)/u);
  if (!separator) {
    return undefined;
  }

  return remainder.slice(separator[0].length);
}
