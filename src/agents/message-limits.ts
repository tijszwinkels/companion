/**
 * Message length bounds, in UTF-16 code units (JavaScript string length).
 *
 * A person typing in a desktop or remote panel composer, or in Activity's
 * text input, may send longer messages than other senders. Speech and typed Activity text
 * that reach a conversation through intent routing count as such direct input.
 */
export const MAX_DIRECT_USER_MESSAGE_LENGTH = 8000;

/**
 * Agent session tools, the external session socket, self-wakes, widgets and
 * remote typed starts (`start-agent`) keep this bound. Their requests are
 * relayed by other programs whose own validation and clients assume it. A
 * remote panel's follow-up (`send-agent`) is a person typing, like the desktop
 * composer, and uses MAX_DIRECT_USER_MESSAGE_LENGTH.
 */
export const MAX_RELAYED_MESSAGE_LENGTH = 4000;
