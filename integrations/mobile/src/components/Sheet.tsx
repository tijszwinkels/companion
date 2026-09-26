/** A bottom sheet with the shared modal focus and browser Back behavior. */

import type { ComponentChildren } from 'preact';

import { CloseIcon } from './icons.tsx';
import { Modal } from './Modal.tsx';

export function Sheet(props: { title: string; onClose(): void; children: ComponentChildren }) {
  return (
    <Modal title={props.title} className="sheet" onClose={props.onClose}>
      {(dismiss) => (
        <>
          <div class="grabber" aria-hidden="true" />
          <header>
            <h2>{props.title}</h2>
            <button class="icon-button" onClick={dismiss} aria-label="Close">
              <CloseIcon />
            </button>
          </header>
          <div class="sheet-body">{props.children}</div>
        </>
      )}
    </Modal>
  );
}
