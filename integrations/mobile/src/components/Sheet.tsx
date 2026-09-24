/**
 * Accessible bottom sheet: a modal dialog that closes on backdrop tap,
 * Escape, or the close button, and returns focus to its opener.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import { CloseIcon } from './icons.tsx';

export function Sheet(props: { title: string; onClose(): void; children: ComponentChildren }) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();

    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        props.onClose();
      }
    };
    document.addEventListener('keydown', keydown);

    return () => {
      document.removeEventListener('keydown', keydown);
      opener?.focus?.();
    };
  }, []);

  return (
    <>
      <div class="backdrop" onClick={props.onClose} />
      <div
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        ref={dialog}
      >
        <div class="grabber" aria-hidden="true" />
        <header>
          <h2>{props.title}</h2>
          <button class="icon-button" onClick={props.onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div class="sheet-body">{props.children}</div>
      </div>
    </>
  );
}
