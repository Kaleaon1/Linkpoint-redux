// Manual mock for circuit.ts's UDP transport, auto-applied by Jest for the
// whole suite (a file at frontend/__mocks__/<pkg>.ts shadows a node_modules
// package with no jest.mock() call needed). Lets tests drive circuit.ts's
// real packet-handling code with synthetic bytes instead of a real socket.
type Handler = (...args: any[]) => void;

export class FakeUdpSocket {
  handlers: Record<string, Handler[]> = {};
  sent: { msg: Uint8Array; port: number; address: string }[] = [];
  closed = false;

  on(event: string, cb: Handler) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  bind(_port: number, cb?: () => void) {
    // Real react-native-udp calls back asynchronously once bound.
    queueMicrotask(() => cb?.());
  }

  send(msg: Uint8Array, _offset: number, _length: number, port: number, address: string, cb?: (err?: Error) => void) {
    this.sent.push({ msg, port, address });
    cb?.();
  }

  close(cb?: () => void) {
    this.closed = true;
    cb?.();
  }

  /** Test helper: feed a synthetic UDP datagram into whatever handler circuit.ts registered. */
  __emit(event: string, ...args: any[]) {
    for (const h of this.handlers[event] ?? []) h(...args);
  }
}

let lastSocket: FakeUdpSocket | null = null;

const dgram = {
  createSocket: jest.fn((_opts: { type: string }) => {
    lastSocket = new FakeUdpSocket();
    return lastSocket;
  }),
  get __lastSocket(): FakeUdpSocket | null {
    return lastSocket;
  },
  __reset() {
    lastSocket = null;
  },
};

export default dgram;
