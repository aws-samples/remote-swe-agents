import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
const PROXY_PORT = 8080;
const TUNNEL_PORT = 9000;
const LIFECYCLE_PREFIX = '/aws/lambda-microvms/runtime/v1';
let tunnelSocket = null;
const pendingRequests = new Map();
const browserWsSockets = new Map();
const browserWsQueues = new Map();
let requestCounter = 0;
const nextId = () => `req-${Date.now()}-${++requestCounter}`;
// --- Tunnel server (port 9000) ---
const tunnelWss = new WebSocketServer({ port: TUNNEL_PORT });
console.log(`[tunnel] Listening on port ${TUNNEL_PORT}`);
tunnelWss.on('connection', (ws) => {
    if (tunnelSocket) {
        console.log('[tunnel] Replacing existing tunnel connection');
        tunnelSocket.close(1000, 'replaced');
    }
    tunnelSocket = ws;
    console.log('[tunnel] Worker connected');
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleTunnelMessage(msg);
        }
        catch (e) {
            console.error('[tunnel] Invalid message:', e);
        }
    });
    ws.on('close', () => {
        console.log('[tunnel] Worker disconnected');
        if (tunnelSocket === ws)
            tunnelSocket = null;
        for (const [id, { res, timer }] of pendingRequests) {
            clearTimeout(timer);
            if (!res.headersSent)
                res.writeHead(502);
            res.end('Tunnel disconnected');
            pendingRequests.delete(id);
        }
    });
    ws.on('error', (err) => {
        console.error('[tunnel] Error:', err.message);
    });
});
function handleTunnelMessage(msg) {
    switch (msg.type) {
        case 'http-response': {
            const pending = pendingRequests.get(msg.id);
            if (!pending)
                return;
            if (msg.streaming) {
                // S7/should-fix 5: Start streaming — write headers, keep response open.
                // Clear the initial timeout; streaming has its own idle timeout.
                clearTimeout(pending.timer);
                pending.streaming = true;
                pending.res.writeHead(msg.status, msg.headers ?? {});
                // Set an idle timeout that resets on each chunk
                pending.timer = setTimeout(() => {
                    const p = pendingRequests.get(msg.id);
                    if (p) {
                        pendingRequests.delete(msg.id);
                        p.res.end();
                    }
                }, 120_000);
            }
            else {
                // Complete response
                clearTimeout(pending.timer);
                pendingRequests.delete(msg.id);
                const headers = msg.headers ?? {};
                pending.res.writeHead(msg.status, headers);
                if (msg.body) {
                    pending.res.end(Buffer.from(msg.body, 'base64'));
                }
                else {
                    pending.res.end();
                }
            }
            break;
        }
        case 'http-response-chunk': {
            const pending = pendingRequests.get(msg.id);
            if (!pending || !pending.streaming)
                return;
            // should-fix 5: Reset idle timeout on each chunk for SSE/streaming
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => {
                const p = pendingRequests.get(msg.id);
                if (p) {
                    pendingRequests.delete(msg.id);
                    p.res.end();
                }
            }, 120_000);
            // Backpressure: if the response socket can't keep up, pause tunnel consumption
            const canWrite = pending.res.write(Buffer.from(msg.data, 'base64'));
            if (!canWrite) {
                pending.res.once('drain', () => {
                    // Resume is handled at the application level; Node will buffer
                });
            }
            break;
        }
        case 'http-response-end': {
            const pending = pendingRequests.get(msg.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.id);
            pending.res.end();
            break;
        }
        case 'ws-opened': {
            break;
        }
        case 'ws-message': {
            const browserWs = browserWsSockets.get(msg.id);
            if (!browserWs || browserWs.readyState !== WebSocket.OPEN)
                return;
            const frame = msg.binary ? Buffer.from(msg.data, 'base64') : msg.data;
            const isBinary = msg.binary;
            sendToBrowserWs(msg.id, browserWs, frame, isBinary);
            break;
        }
        case 'ws-close': {
            const browserWs = browserWsSockets.get(msg.id);
            if (browserWs) {
                browserWs.close(msg.code ?? 1000, msg.reason);
                browserWsSockets.delete(msg.id);
                browserWsQueues.delete(msg.id);
            }
            break;
        }
        case 'ws-error': {
            const browserWs = browserWsSockets.get(msg.id);
            if (browserWs) {
                browserWs.close(1011, msg.message);
                browserWsSockets.delete(msg.id);
                browserWsQueues.delete(msg.id);
            }
            break;
        }
        case 'pong':
            break;
        default:
            break;
    }
}
// Browser WS backpressure: queue + timer flush (ws lib doesn't emit 'drain')
const BROWSER_WS_HIGH_WATER = 4 * 1024 * 1024;
const BROWSER_WS_FLUSH_INTERVAL = 50;
function sendToBrowserWs(id, ws, data, _binary) {
    let queue = browserWsQueues.get(id);
    if (queue && queue.length > 0) {
        if (queue.length < 2000)
            queue.push(data);
        return;
    }
    if (ws.bufferedAmount > BROWSER_WS_HIGH_WATER) {
        if (!queue) {
            queue = [];
            browserWsQueues.set(id, queue);
        }
        queue.push(data);
        scheduleBrowserWsFlush(id, ws);
        return;
    }
    ws.send(data);
}
function scheduleBrowserWsFlush(id, ws) {
    setTimeout(() => {
        const queue = browserWsQueues.get(id);
        if (!queue || queue.length === 0)
            return;
        if (ws.readyState !== WebSocket.OPEN) {
            browserWsQueues.delete(id);
            return;
        }
        while (queue.length > 0 && ws.bufferedAmount <= BROWSER_WS_HIGH_WATER) {
            const frame = queue.shift();
            ws.send(frame);
        }
        if (queue.length > 0) {
            scheduleBrowserWsFlush(id, ws);
        }
    }, BROWSER_WS_FLUSH_INTERVAL);
}
// --- Proxy HTTP server (port 8080) ---
const proxyServer = createServer((req, res) => {
    if (req.url?.startsWith(LIFECYCLE_PREFIX)) {
        handleLifecycleHook(req, res);
        return;
    }
    if (!tunnelSocket || tunnelSocket.readyState !== WebSocket.OPEN) {
        res.writeHead(502).end('No tunnel connection available');
        return;
    }
    const id = nextId();
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('base64') : undefined;
        const headers = {};
        for (const [key, val] of Object.entries(req.headers)) {
            if (val)
                headers[key] = Array.isArray(val) ? val.join(', ') : val;
        }
        delete headers['x-aws-proxy-auth'];
        delete headers['x-aws-proxy-port'];
        const tunnelReq = {
            type: 'http-request',
            id,
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            headers,
            body,
        };
        const timer = setTimeout(() => {
            const pending = pendingRequests.get(id);
            if (pending) {
                pendingRequests.delete(id);
                if (!pending.res.headersSent)
                    pending.res.writeHead(504);
                pending.res.end('Gateway timeout');
            }
        }, 120_000);
        pendingRequests.set(id, { res, timer, streaming: false });
        tunnelSocket.send(JSON.stringify(tunnelReq));
    });
});
// WebSocket upgrade for browser connections (HMR)
const browserWss = new WebSocketServer({ noServer: true });
proxyServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith(LIFECYCLE_PREFIX)) {
        socket.destroy();
        return;
    }
    if (!tunnelSocket || tunnelSocket.readyState !== WebSocket.OPEN) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
        return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
        const id = nextId();
        browserWsSockets.set(id, ws);
        const headers = {};
        for (const [key, val] of Object.entries(req.headers)) {
            if (val && key !== 'x-aws-proxy-auth' && key !== 'x-aws-proxy-port') {
                headers[key] = Array.isArray(val) ? val.join(', ') : val;
            }
        }
        const openMsg = {
            type: 'ws-open',
            id,
            path: req.url ?? '/',
            headers,
        };
        tunnelSocket.send(JSON.stringify(openMsg));
        ws.on('message', (data, isBinary) => {
            if (!tunnelSocket || tunnelSocket.readyState !== WebSocket.OPEN) {
                ws.close(1011, 'Tunnel disconnected');
                return;
            }
            const msg = {
                type: 'ws-message',
                id,
                data: isBinary ? data.toString('base64') : data.toString(),
                binary: isBinary,
            };
            tunnelSocket.send(JSON.stringify(msg));
        });
        ws.on('close', (code, reason) => {
            browserWsSockets.delete(id);
            browserWsQueues.delete(id);
            if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
                const closeMsg = { type: 'ws-close', id, code, reason: reason.toString() };
                tunnelSocket.send(JSON.stringify(closeMsg));
            }
        });
        ws.on('error', () => {
            browserWsSockets.delete(id);
            browserWsQueues.delete(id);
        });
    });
});
proxyServer.listen(PROXY_PORT, () => {
    console.log(`[proxy] Listening on port ${PROXY_PORT}`);
});
// --- Lifecycle hooks ---
function handleLifecycleHook(req, res) {
    const path = req.url?.replace(LIFECYCLE_PREFIX, '') ?? '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log(`[lifecycle] ${path}`, body ? JSON.parse(body) : '');
        switch (path) {
            case '/run':
            case '/resume':
            case '/validate':
                res.writeHead(200).end();
                break;
            case '/suspend':
                if (tunnelSocket)
                    tunnelSocket.close(1001, 'MicroVM suspending');
                res.writeHead(200).end();
                break;
            case '/terminate':
                if (tunnelSocket)
                    tunnelSocket.close(1001, 'MicroVM terminating');
                res.writeHead(200).end();
                break;
            case '/ready':
                res.writeHead(200).end();
                break;
            default:
                res.writeHead(404).end();
        }
    });
}
// Keep-alive ping to tunnel
setInterval(() => {
    if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
        tunnelSocket.send(JSON.stringify({ type: 'ping' }));
    }
}, 30_000);
