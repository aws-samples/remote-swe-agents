/**
 * Tunnel protocol message types used between the MicroVM proxy and the
 * AgentCore worker. Messages are JSON-encoded and sent over the WebSocket
 * tunnel connection.
 *
 * This is the canonical definition. The MicroVM proxy references these types directly.
 */

export type TunnelHttpRequest = {
  type: 'http-request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string; // base64
};

export type TunnelHttpResponse = {
  type: 'http-response';
  id: string;
  status: number;
  headers: Record<string, string>;
  body?: string; // base64, omitted when streaming=true
  streaming?: boolean; // when true, data arrives as http-response-chunk messages
};

export type TunnelHttpResponseChunk = {
  type: 'http-response-chunk';
  id: string;
  data: string; // base64
};

export type TunnelHttpResponseEnd = {
  type: 'http-response-end';
  id: string;
};

export type TunnelWsOpen = {
  type: 'ws-open';
  id: string;
  path: string;
  headers: Record<string, string>;
};

export type TunnelWsOpened = {
  type: 'ws-opened';
  id: string;
};

export type TunnelWsMessage = {
  type: 'ws-message';
  id: string;
  data: string;
  binary: boolean;
};

export type TunnelWsClose = {
  type: 'ws-close';
  id: string;
  code?: number;
  reason?: string;
};

export type TunnelWsError = {
  type: 'ws-error';
  id: string;
  message: string;
};

export type TunnelPing = {
  type: 'ping';
};

export type TunnelPong = {
  type: 'pong';
};

export type TunnelMessage =
  | TunnelHttpRequest
  | TunnelHttpResponse
  | TunnelHttpResponseChunk
  | TunnelHttpResponseEnd
  | TunnelWsOpen
  | TunnelWsOpened
  | TunnelWsMessage
  | TunnelWsClose
  | TunnelWsError
  | TunnelPing
  | TunnelPong;
