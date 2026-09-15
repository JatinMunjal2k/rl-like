/**
 * WebRTC transport on top of PeerJS. PeerJS does the signalling (its free public broker) and
 * gives us one reliable, ordered data channel per peer. For game traffic we open a second
 * channel on the same connection, unordered with no retransmits, so a lost packet never holds
 * up the ones behind it. If that channel is not available, game packets ride the reliable one.
 */
import { Peer, type DataConnection } from 'peerjs';
import type { CtrlMsg } from './protocol';

const ID_PREFIX = 'rl-like-v1-';
/** Unambiguous room-code alphabet: no 0/O, 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length = 5): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function peerIdForCode(code: string): string {
  return ID_PREFIX + normalizeCode(code);
}

/** One connection to a remote peer: a reliable JSON channel and (once set up) a fast binary one. */
export class Link {
  onCtrl: ((msg: CtrlMsg) => void) | null = null;
  onFast: ((buf: ArrayBuffer) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  private fast: RTCDataChannel | null = null;

  constructor(
    readonly conn: DataConnection,
    /** The host side receives the fast channel; the client side creates it. */
    private readonly hostSide: boolean,
  ) {
    conn.on('data', (data: unknown) => {
      if (typeof data === 'string') {
        let msg: CtrlMsg;
        try {
          msg = JSON.parse(data) as CtrlMsg;
        } catch {
          return;
        }
        if (msg.t === 'fastready' && !this.hostSide) {
          this.createFastChannel();
          return;
        }
        this.onCtrl?.(msg);
      } else if (data instanceof ArrayBuffer) {
        this.onFast?.(data);
      } else if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        this.onFast?.(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
      }
    });
    conn.on('close', () => this.handleClose());
    conn.on('error', () => this.handleClose());
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.handleClose();
    });
  }

  /** Call once the reliable channel is open. Host side: listen for the fast channel and invite it. */
  start(): void {
    if (this.hostSide) {
      const pc = this.conn.peerConnection;
      if (pc) {
        // PeerJS would otherwise adopt any new channel as its own; from here on new channels are ours.
        pc.ondatachannel = (evt) => {
          if (evt.channel.label === 'fast') this.adoptFast(evt.channel);
        };
        this.sendCtrl({ t: 'fastready' });
      }
    }
  }

  get fastOpen(): boolean {
    return this.fast !== null && this.fast.readyState === 'open';
  }

  private createFastChannel(): void {
    const pc = this.conn.peerConnection;
    if (!pc || this.fast) return;
    try {
      const ch = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
      this.adoptFast(ch);
    } catch {
      /* stay on the reliable channel */
    }
  }

  private adoptFast(ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onFast?.(e.data);
    };
    ch.onclose = () => {
      if (this.fast === ch) this.fast = null;
    };
    ch.onerror = () => {
      if (this.fast === ch) this.fast = null;
    };
    this.fast = ch;
  }

  sendCtrl(msg: CtrlMsg): void {
    if (this.closed || !this.conn.open) return;
    try {
      this.conn.send(JSON.stringify(msg));
    } catch {
      /* dropped */
    }
  }

  sendFast(buf: ArrayBuffer): void {
    if (this.closed) return;
    if (this.fast && this.fast.readyState === 'open') {
      // Do not queue behind a stalled link: game packets are only useful fresh.
      if (this.fast.bufferedAmount > 64 * 1024) return;
      try {
        this.fast.send(buf);
        return;
      } catch {
        /* fall through */
      }
    }
    if (this.conn.open) {
      try {
        this.conn.send(buf);
      } catch {
        /* dropped */
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.fast?.close();
    } catch {
      /* ignore */
    }
    try {
      this.conn.close();
    } catch {
      /* ignore */
    }
    this.onClose?.();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
    const onError = (err: Error & { type?: string }) => {
      peer.destroy();
      reject(err);
    };
    peer.once('open', () => {
      peer.off('error', onError);
      resolve(peer);
    });
    peer.once('error', onError);
  });
}

/** Register a room with the signalling server. Retries with a fresh code if one is taken. */
export async function hostRoom(): Promise<{ peer: Peer; code: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const peer = await openPeer(peerIdForCode(code));
      return { peer, code };
    } catch (err) {
      const type = (err as { type?: string }).type;
      if (type !== 'unavailable-id') throw err;
    }
  }
  throw new Error('Could not find a free room code');
}

/** Connect to a room. Resolves once the reliable channel is open. */
export async function joinRoom(code: string, timeoutMs = 15000): Promise<{ peer: Peer; link: Link }> {
  const peer = await openPeer();
  return new Promise((resolve, reject) => {
    const conn = peer.connect(peerIdForCode(code), { serialization: 'raw', reliable: true });
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error('Timed out connecting to the room'));
    }, timeoutMs);
    const fail = (err: Error & { type?: string }) => {
      clearTimeout(timer);
      peer.destroy();
      reject(err.type === 'peer-unavailable' ? new Error('No room with that code') : err);
    };
    peer.once('error', fail);
    conn.once('open', () => {
      clearTimeout(timer);
      peer.off('error', fail);
      const link = new Link(conn, false);
      link.start();
      resolve({ peer, link });
    });
    conn.once('error', (e) => fail(e as Error));
  });
}

/** Wrap each incoming connection on a hosting peer. */
export function acceptConnections(peer: Peer, onLink: (link: Link) => void): void {
  peer.on('connection', (conn) => {
    conn.once('open', () => {
      const link = new Link(conn, true);
      link.start();
      onLink(link);
    });
  });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
