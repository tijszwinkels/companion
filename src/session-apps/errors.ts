/**
 * An application request refusal with an HTTP status for the view protocol:
 * 409 for stale code versions or revisions, 503 for retryable busy refusals,
 * 400 (the default) for invalid requests. Agent tools receive the message.
 */
export class SessionApplicationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SessionApplicationError';
  }
}
