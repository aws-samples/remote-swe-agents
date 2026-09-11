import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
import type {
  TunnelMessage,
  TunnelHttpRequest,
  TunnelHttpResponse,
  TunnelHttpResponseChunk,
  TunnelHttpResponseEnd,
  TunnelWsOpen,
  TunnelWsOpened,
  TunnelWsMessage,
  TunnelWsClose,
} from './protocol.js';

export class TunnelClient {
  private ws: WebSocket | null = null;
  private localWsSockets = new Map<string, WebSocket>();
  private closed = false;
  private sendQueue: TunnelMessage[] = [];
  private authToken: string;

  constructor(
    private readonly microvmEndpoint: string,
    private readonly tunnelPort: number,
    private readonly localPort: number,
    initialToken: string,
    private readonly onDisconnect?: () => void
  ) {
    this.authToken = initialToken;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocols = [
        'lambda-microvms',
        `lambda-microvms.authentication.${this.authToken}`,
        `lambda-microvms.port.${this.tunnelPort}`,
      ];

      const url = `wss://${this.microvmEndpoint}/tunnel`;
      this.ws = new WebSocket(url, protocols);

      const timeout = setTimeout(() => {
        reject(new Error('Tunnel connection timeout'));
        this.ws?.terminate();
      }, 30_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.flushQueue();
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg: TunnelMessage = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (e) {
          console.error('[tunnel-client] Invalid message:', e);
        }
      });

      this.ws.on('close', () => {
        if (!this.closed) {
          this.onDisconnect?.();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[tunnel-client] Error:', err.message);
        reject(err);
      });
    });
  }

  // S5: Atomic token refresh - old connection stays active until new one is confirmed
  updateAuthToken(newToken: string): void {
    this.authToken = newToken;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const oldWs = this.ws;
    // DO NOT set this.ws = null here (S5: keep old connection for in-flight messages)

    const protocols = [
      'lambda-microvms',
      `lambda-microvms.authentication.${newToken}`,
      `lambda-microvms.port.${this.tunnelPort}`,
    ];
    const url = `wss://${this.microvmEndpoint}/tunnel`;
    const newWs = new WebSocket(url, protocols);

    newWs.on('open', () => {
      // Atomically swap to new connection only after it's open
      this.ws = newWs;
      oldWs.close(1000, 'token-refresh');
      this.flushQueue();
    });

    newWs.on('message', (data) => {
      try {
        const msg: TunnelMessage = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        console.error('[tunnel-client] Invalid message:', e);
      }
    });

    newWs.on('close', () => {
      if (this.ws === newWs && !this.closed) {
        this.onDisconnect?.();
      }
    });

    newWs.on('error', (err) => {
      console.error('[tunnel-client] Reconnect error:', err.message);
      // Keep old connection if new one fails
      if (oldWs.readyState === WebSocket.OPEN) {
        this.ws = oldWs;
      }
    });
  }

  close(): void {
    this.closed = true;
    for (const ws of this.localWsSockets.values()) {
      ws.close(1001);
    }
    this.localWsSockets.clear();
    this.ws?.close(1000, 'preview-closed');
    this.ws = null;
  }

  terminate(): void {
    this.closed = true;
    for (const ws of this.localWsSockets.values()) {
      ws.terminate();
    }
    this.localWsSockets.clear();
    this.ws?.terminate();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private handleMessage(msg: TunnelMessage): void {
    switch (msg.type) {
      case 'http-request':
        this.handleHttpRequest(msg);
        break;
      case 'ws-open':
        this.handleWsOpen(msg);
        break;
      case 'ws-message':
        this.handleWsMessage(msg);
        break;
      case 'ws-close':
        this.handleWsClose(msg);
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      default:
        break;
    }
  }

  // S7: Streaming HTTP response support
  private handleHttpRequest(msg: TunnelHttpRequest): void {
    const hopByHopHeaders = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]);

    const options = {
      hostname: '127.0.0.1',
      port: this.localPort,
      path: msg.path,
      method: msg.method,
      headers: { ...msg.headers, host: `localhost:${this.localPort}` },
    };

    // Remove hop-by-hop and preview-specific headers
    delete (options.headers as Record<string, string>)['x-aws-proxy-auth'];
    delete (options.headers as Record<string, string>)['x-aws-proxy-port'];
    for (const h of hopByHopHeaders) {
      delete (options.headers as Record<string, string>)[h];
    }

    const req = httpRequest(options, (res) => {
      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(res.headers)) {
        if (val && !hopByHopHeaders.has(key.toLowerCase())) {
          headers[key] = Array.isArray(val) ? val.join(', ') : val;
        }
      }

      const isStreaming =
        headers['content-type']?.includes('text/event-stream') || headers['transfer-encoding'] === 'chunked';

      if (isStreaming) {
        // S7: Stream chunks for SSE/streaming responses
        const headerMsg: TunnelHttpResponse = {
          type: 'http-response',
          id: msg.id,
          status: res.statusCode ?? 200,
          headers,
          streaming: true,
        };
        this.send(headerMsg);

        res.on('data', (chunk: Buffer) => {
          const chunkMsg: TunnelHttpResponseChunk = {
            type: 'http-response-chunk',
            id: msg.id,
            data: chunk.toString('base64'),
          };
          this.send(chunkMsg);
        });

        res.on('end', () => {
          const endMsg: TunnelHttpResponseEnd = { type: 'http-response-end', id: msg.id };
          this.send(endMsg);
        });
      } else {
        // Non-streaming: buffer and send complete response
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = chunks.length > 0 ? Buffer.concat(chunks).toString('base64') : undefined;
          const response: TunnelHttpResponse = {
            type: 'http-response',
            id: msg.id,
            status: res.statusCode ?? 500,
            headers,
            body,
          };
          this.send(response);
        });
      }
    });

    req.on('error', (err) => {
      const response: TunnelHttpResponse = {
        type: 'http-response',
        id: msg.id,
        status: 502,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(`Local server error: ${err.message}`).toString('base64'),
      };
      this.send(response);
    });

    if (msg.body) {
      req.write(Buffer.from(msg.body, 'base64'));
    }
    req.end();
  }

  private handleWsOpen(msg: TunnelWsOpen): void {
    const url = `ws://127.0.0.1:${this.localPort}${msg.path}`;
    const headers: Record<string, string> = { ...msg.headers, host: `localhost:${this.localPort}` };
    delete headers['x-aws-proxy-auth'];
    delete headers['x-aws-proxy-port'];
    // Remove hop-by-hop and WebSocket handshake headers that the ws library
    // generates internally. Forwarding them causes duplicate/conflicting headers
    // leading to 400 Bad Request from the local dev server.
    delete headers['connection'];
    delete headers['upgrade'];
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    // Origin header must be removed: dev servers (Vite 8+) validate WebSocket
    // origin and reject non-localhost origins with 400.
    delete headers['origin'];
    const subprotocol = headers['sec-websocket-protocol'];
    delete headers['sec-websocket-protocol'];
    const protocols = subprotocol ? subprotocol.split(',').map((p) => p.trim()) : undefined;
    const localWs = new WebSocket(url, protocols, { headers });

    localWs.on('open', () => {
      this.localWsSockets.set(msg.id, localWs);
      const opened: TunnelWsOpened = { type: 'ws-opened', id: msg.id };
      this.send(opened);
    });

    localWs.on('message', (data, isBinary) => {
      const wsMsg: TunnelWsMessage = {
        type: 'ws-message',
        id: msg.id,
        data: isBinary ? (data as Buffer).toString('base64') : data.toString(),
        binary: isBinary,
      };
      this.send(wsMsg);
    });

    localWs.on('close', (code, reason) => {
      this.localWsSockets.delete(msg.id);
      const closeMsg: TunnelWsClose = { type: 'ws-close', id: msg.id, code, reason: reason.toString() };
      this.send(closeMsg);
    });

    localWs.on('error', (err) => {
      this.localWsSockets.delete(msg.id);
      this.send({ type: 'ws-error', id: msg.id, message: err.message });
    });
  }

  private handleWsMessage(msg: TunnelWsMessage): void {
    const localWs = this.localWsSockets.get(msg.id);
    if (!localWs || localWs.readyState !== WebSocket.OPEN) return;
    if (msg.binary) {
      localWs.send(Buffer.from(msg.data, 'base64'));
    } else {
      localWs.send(msg.data);
    }
  }

  private handleWsClose(msg: TunnelWsClose): void {
    const localWs = this.localWsSockets.get(msg.id);
    if (localWs) {
      localWs.close(msg.code ?? 1000, msg.reason);
      this.localWsSockets.delete(msg.id);
    }
  }

  // should-fix 3 (R3-3): Backpressure — always route through queue if queue is non-empty
  // to prevent out-of-order delivery when direct send resumes before queue is flushed.
  private send(msg: TunnelMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // If there are queued messages, always queue to preserve order
      if (this.sendQueue.length > 0) {
        if (this.sendQueue.length < 2000) {
          this.sendQueue.push(msg);
        }
        this.scheduleDrain();
        return;
      }
      // Check backpressure
      if (this.ws.bufferedAmount > 16 * 1024 * 1024) {
        if (this.sendQueue.length < 2000) {
          this.sendQueue.push(msg);
        }
        this.scheduleDrain();
        return;
      }
      this.ws.send(JSON.stringify(msg));
    } else if (!this.closed) {
      // Buffer during reconnection/refresh
      if (this.sendQueue.length < 2000) {
        this.sendQueue.push(msg);
      }
    }
  }

  private drainScheduled = false;

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setTimeout(() => {
      this.drainScheduled = false;
      this.flushQueue();
    }, 50);
  }

  private flushQueue(): void {
    while (this.sendQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      // Respect backpressure during flush
      if (this.ws.bufferedAmount > 16 * 1024 * 1024) {
        this.scheduleDrain();
        return;
      }
      const msg = this.sendQueue.shift()!;
      this.ws.send(JSON.stringify(msg));
    }
  }
}
