/**
 * Tunnel protocol message types.
 * IMPORTANT: This file must stay in sync with packages/agent-core/src/tools/preview/protocol.ts
 * which is the canonical definition.
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
  body?: string; // base64
  streaming?: boolean;
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
