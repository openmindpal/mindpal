declare module 'ws' {
  import EventEmitter = require('events');
  
  export interface WebSocket extends EventEmitter {
    readyState: number;
    send(data: string | Buffer, cb?: (err?: Error) => void): void;
    close(code?: number, data?: string | Buffer): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
  }
  
  export const WebSocket: {
    new(url: string, options?: { headers?: Record<string, string> }): WebSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
}
