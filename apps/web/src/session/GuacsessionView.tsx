import { useEffect, useRef, type JSX } from 'react';
import Guacamole, { type Client, type MouseState, type Status } from 'guacamole-common-js';
import { createDfapTunnel, type DfapTunnel } from './dfap-tunnel.js';
import styles from './GuacsessionView.module.css';

/**
 * GuacsessionView — renders one live pixel session and is **isolation layer 4**
 * (docs/security.md, Guarantee 1). Layers 1-3 (guacd params, the broker
 * instruction filter, guest OS policy) already make a data channel impossible
 * on the server side. This component makes it impossible from the client side
 * too: even a future code regression here cannot open a file/clipboard bridge,
 * because the handlers that would carry one are explicitly nulled and the DOM
 * affordances that leak data (drag, drop, context menu, text selection) are
 * neutralised.
 *
 * Every layer-4 measure below is tagged `isolation layer 4` so it is
 * unmissable in review and grep-able in audits.
 */

/** Guacamole.Client numeric states (not exported by the lib). */
const CLIENT_STATE_CONNECTED = 3;
const CLIENT_STATE_DISCONNECTED = 5;

/** Guacamole keysym for pressed/released in sendKeyEvent. */
const KEY_RELEASED = 0;
const KEY_PRESSED = 1;

export interface GuacsessionViewProps {
  /** Broker WebSocket base URL from the control plane. */
  brokerUrl: string;
  /** Opaque DFAP1 handle (single-use, ~60 s). Sent as the first WS frame. */
  token: string;
  /** Fired when the encrypted channel opens (token accepted). */
  onChannelOpen?: () => void;
  /** Fired on the first rendered frame / Guacamole CONNECTED. */
  onConnected?: () => void;
  /**
   * Fired when the socket closes. `transient` is false only when *we* asked to
   * disconnect (unmount / user end); true means an unexpected drop that the
   * caller may choose to reconnect from.
   */
  onClose?: (transient: boolean) => void;
  /** Fired on an unrecoverable protocol/transport error. */
  onError?: (reason: string) => void;
}

export function GuacsessionView(props: GuacsessionViewProps): JSX.Element {
  const { brokerUrl, token, onChannelOpen, onConnected, onClose, onError } = props;

  // The div that hosts Guacamole's rendered <canvas> stack.
  const displayRef = useRef<HTMLDivElement | null>(null);
  // Transparent input surface stacked above the canvas — see layer-4 notes.
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest callbacks in refs so the connect effect can run exactly
  // once per (brokerUrl, token) without re-subscribing on every render.
  const cbs = useRef({ onChannelOpen, onConnected, onClose, onError });
  cbs.current = { onChannelOpen, onConnected, onClose, onError };

  useEffect(() => {
    const displayEl = displayRef.current;
    const overlayEl = overlayRef.current;
    if (!displayEl || !overlayEl) return;

    // True while WE are the ones tearing down, so the resulting socket close is
    // reported as intentional (transient === false) rather than a drop.
    let intentional = false;

    const tunnel: DfapTunnel = createDfapTunnel({
      brokerUrl,
      token,
      onOpen: () => cbs.current.onChannelOpen?.(),
    });

    const client: Client = new Guacamole.Client(tunnel);

    // ─── isolation layer 4: NEVER attach data-channel handlers ──────────────
    // guacd→client streams for files/clipboard/named pipes are already dropped
    // by the broker's instruction filter (layer 2). Here we guarantee that even
    // if one arrived, there is no handler to receive it. Assigning `null` (not
    // merely leaving it undefined) is deliberate and documents intent.
    client.onfile = null; // isolation layer 4: no file downloads/uploads, ever
    client.onclipboard = null; // isolation layer 4: no clipboard bridge, ever
    client.onpipe = null; // isolation layer 4: no named-pipe data streams, ever
    // isolation layer 4: we also never instantiate Guacamole.OnScreenKeyboard's
    // clipboard, never construct a Guacamole.OutputStream/InputStream, and never
    // call client.createFileStream / createClipboardStream. There is no code
    // path in this component that opens an outbound stream to the guest.

    // Mount the rendered display beneath the input overlay.
    const display = client.getDisplay();
    const displayNode = display.getElement();
    // isolation layer 4: the pixel surface itself must not be user-selectable
    // or draggable (belt-and-braces with the CSS module).
    displayNode.style.userSelect = 'none';
    (displayNode.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none';
    displayNode.setAttribute('draggable', 'false');
    displayEl.appendChild(displayNode);

    // ─── Input wiring ───────────────────────────────────────────────────────
    // Mouse and Keyboard listen on the transparent overlay, which is the top
    // element in the stack. That keeps input flowing to guacd while letting the
    // overlay veto the browser's own drag/context-menu/selection behaviour.
    const mouse = new Guacamole.Mouse(overlayEl);
    const sendMouse = (state: MouseState): void => client.sendMouseState(state);
    mouse.onmousedown = sendMouse;
    mouse.onmouseup = sendMouse;
    mouse.onmousemove = sendMouse;
    // On mouse-out, release all buttons so a drag can't "stick" outside the view.
    mouse.onmouseout = () => {
      client.sendMouseState({ x: 0, y: 0, left: false, middle: false, right: false, up: false, down: false });
    };

    const keyboard = new Guacamole.Keyboard(overlayEl);
    keyboard.onkeydown = (keysym: number) => {
      client.sendKeyEvent(KEY_PRESSED, keysym);
      // Returning true tells Guacamole.Keyboard we handled it (prevents default
      // browser action for that key) — part of keeping the browser inert.
      return true;
    };
    keyboard.onkeyup = (keysym: number) => {
      client.sendKeyEvent(KEY_RELEASED, keysym);
    };

    // ─── isolation layer 4: neutralise browser data affordances ─────────────
    // Context menu, drag-start, and drop are the classic accidental exfil/inject
    // paths in a canvas app. We refuse all three on the overlay. We register NO
    // 'drop' *handler* that reads files — we only preventDefault so the browser
    // never navigates to or ingests dropped content.
    const prevent = (e: Event): void => e.preventDefault();
    overlayEl.addEventListener('contextmenu', prevent); // isolation layer 4: no right-click menu
    overlayEl.addEventListener('dragstart', prevent); // isolation layer 4: nothing is draggable out
    overlayEl.addEventListener('dragover', prevent); // isolation layer 4: refuse drag-in
    overlayEl.addEventListener('drop', prevent); // isolation layer 4: refuse file drop-in
    // Focus the overlay so keystrokes are captured immediately.
    overlayEl.setAttribute('tabindex', '0');
    overlayEl.focus();

    // ─── Client lifecycle ───────────────────────────────────────────────────
    client.onstatechange = (state: number) => {
      if (state === CLIENT_STATE_CONNECTED) {
        cbs.current.onConnected?.();
      } else if (state === CLIENT_STATE_DISCONNECTED) {
        cbs.current.onClose?.(!intentional);
      }
    };

    client.onerror = (status: Status) => {
      cbs.current.onError?.(status.message ?? `guacamole error ${status.code}`);
    };

    // Kick off the connection. The empty connect data is intentional: the token
    // (sent first by the tunnel) plus server-side params are all guacd needs.
    client.connect('');

    // ─── Teardown ───────────────────────────────────────────────────────────
    return () => {
      intentional = true;
      overlayEl.removeEventListener('contextmenu', prevent);
      overlayEl.removeEventListener('dragstart', prevent);
      overlayEl.removeEventListener('dragover', prevent);
      overlayEl.removeEventListener('drop', prevent);
      try {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        keyboard.reset();
      } catch {
        /* keyboard may already be detached */
      }
      mouse.onmousedown = null;
      mouse.onmouseup = null;
      mouse.onmousemove = null;
      mouse.onmouseout = null;
      try {
        client.disconnect();
      } catch {
        /* already disconnected */
      }
      // Detach the canvas node we appended.
      if (displayNode.parentNode === displayEl) displayEl.removeChild(displayNode);
    };
    // Reconnects are driven by the parent remounting this component with a fresh
    // token (see SessionView), so (brokerUrl, token) is the correct dep set.
  }, [brokerUrl, token]);

  return (
    <div className={styles.stage} data-testid="guac-stage">
      {/* Rendered pixels live here. */}
      <div ref={displayRef} className={styles.display} />
      {/*
        isolation layer 4: transparent input surface. `user-select:none` and
        `-webkit-user-select:none` (in the CSS module) plus `draggable=false`
        mean text and images in the pixel stream cannot be selected or dragged
        out of the browser. It sits above the canvas and owns all input.
      */}
      <div ref={overlayRef} className={styles.inputOverlay} draggable={false} aria-label="Remote session input surface" />
    </div>
  );
}
