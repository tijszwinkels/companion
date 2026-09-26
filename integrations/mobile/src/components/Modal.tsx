/** Shared modal lifetime: browser Back, Escape, focus containment and restoration. */

import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { useStore } from '../hooks.ts';

export function Modal(props: {
  title: string;
  className: string;
  onClose(): void;
  children(dismiss: () => void): ComponentChildren;
}) {
  const store = useStore();
  const layer = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const registration = useRef<ReturnType<typeof store.navigation.openModal>>();

  useLayoutEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    const siblings = [...document.body.children].filter(
      (sibling): sibling is HTMLElement =>
        sibling instanceof HTMLElement && sibling !== layer.current,
    );
    const previousInert = siblings.map((sibling) => sibling.inert);
    for (const sibling of siblings) {
      sibling.inert = true;
    }
    registration.current = store.navigation.openModal(() => close.current());
    element.focus();

    const keydown = (event: KeyboardEvent) => {
      if (layer.current?.inert) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        registration.current?.dismiss();
      } else if (event.key === 'Tab') {
        const controls = [
          ...element.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
          ),
        ].filter((control) => control.getClientRects().length > 0);
        const first = controls[0] ?? element;
        const last = controls.at(-1) ?? element;
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === element)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === element)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);

    return () => {
      registration.current?.release();
      document.removeEventListener('keydown', keydown);
      siblings.forEach((sibling, index) => {
        sibling.inert = previousInert[index];
      });
      // A close action can remove its opener (closing a conversation or signing
      // out). Wait for that render, then focus the page heading/pairing field.
      queueMicrotask(() => {
        const target =
          opener?.isConnected && !opener.closest('[inert]')
            ? opener
            : document.querySelector<HTMLElement>('[data-page-heading], #code');
        target?.focus({ preventScroll: true });
      });
    };
  }, [store]);

  const dismiss = () => registration.current?.dismiss();
  return createPortal(
    <div class="modal-layer" ref={layer}>
      <div class="backdrop" onClick={dismiss} />
      <div
        class={props.className}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        ref={dialog}
      >
        {props.children(dismiss)}
      </div>
    </div>,
    document.body,
  );
}
