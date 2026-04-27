export default {
  async fetch(request: Request): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };

    const url = new URL(request.url);

    // Route: WebSocket for real-time console
    if (url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader === "websocket") {
        return handleWebSocket();
      }
    }

    // Route: Event streaming (SSE) for logs
    if (url.pathname === "/events") {
      return handleSSE();
    }

    // Route: API logs endpoint
    if (url.pathname === "/api/logs") {
      return new Response(JSON.stringify(globalThis.requestLogs || []), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // Route: CORS Proxy
    if (url.pathname === "/proxy" || url.pathname === "/cors") {
      return handleProxy(request, corsHeaders);
    }

    // Route: Main Interactive UI
    return new Response(INTERACTIVE_DASHBOARD, {
      headers: { "content-type": "text/html;charset=UTF-8" },
    });
  },
} satisfies ExportedHandler;

// Global logs storage
declare global {
  var requestLogs: Array<any>;
}
globalThis.requestLogs = globalThis.requestLogs || [];

async function handleProxy(request: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url") || url.searchParams.get("apiurl");

  if (!targetUrl) {
    return new Response(JSON.stringify({
      error: "Missing url parameter. Usage: /proxy?url=https://api.example.com/data",
      tip: "Visit / for the interactive testing UI"
    }), {
      status: 400,
      headers: { ...corsHeaders, "content-type": "application/json" }
    });
  }

  // Validate URL
  try {
    new URL(targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid URL format" }), {
      status: 400,
      headers: { ...corsHeaders, "content-type": "application/json" }
    });
  }

  // Handle preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
      },
    });
  }

  const startTime = Date.now();

  try {
    // Create proxied request
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    // Clean headers
    modifiedRequest.headers.delete("CF-Connecting-IP");
    modifiedRequest.headers.delete("CF-Ray");
    modifiedRequest.headers.set("Origin", new URL(targetUrl).origin);

    const response = await fetch(modifiedRequest);
    const duration = Date.now() - startTime;

    // Log the request
    const logEntry = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), method: request.method, target: targetUrl, status: response.status, duration: duration, size: 0 };
    globalThis.requestLogs.unshift(logEntry);
    if (globalThis.requestLogs.length > 100) globalThis.requestLogs.pop();

    // Clone response with CORS headers
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // Add CORS headers
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newResponse.headers.set(key, value);
    });
    newResponse.headers.set("X-Proxy-Status", "success");
    newResponse.headers.set("X-Response-Time", `${duration}ms`);

    return newResponse;
  } catch (error) {
    return new Response(JSON.stringify({ error: "Proxy Error", message: error instanceof Error ? error.message : "Unknown error", target: targetUrl }), {
      status: 502,
      headers: { ...corsHeaders, "content-type": "application/json" }
    });
  }
}

function handleWebSocket(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  server.addEventListener("message", async (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (data.type === "proxy") {
        const { url: targetUrl, method = "GET", headers = {}, body } = data;
        server.send(JSON.stringify({ type: "status", message: `→ ${method} ${targetUrl}` }));
        try {
          const startTime = Date.now();
          const response = await fetch(targetUrl, {
            method,
            headers: { "User-Agent": "Cloudflare-Worker-Proxy/1.0", ...headers },
            body: body ? JSON.stringify(body) : undefined,
          });
          const responseText = await response.text();
          const duration = Date.now() - startTime;
          server.send(JSON.stringify({ type: "response", status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: responseText.substring(0, 50000), size: responseText.length, duration: `${duration}ms`, timestamp: new Date().toISOString(), }));

          globalThis.requestLogs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method: method, target: targetUrl, status: response.status, duration: duration, via: "websocket" });
        } catch (err) {
          server.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "Request failed", target: targetUrl }));
        }
      } else if (data.type === "ping") {
        server.send(JSON.stringify({ type: "pong", time: Date.now() }));
      } else if (data.type === "getLogs") {
        server.send(JSON.stringify({ type: "logs", data: globalThis.requestLogs.slice(0, 50) }));
      } else if (data.type === "clearLogs") {
        globalThis.requestLogs = [];
        server.send(JSON.stringify({ type: "logs", data: [] }));
      }
    } catch (e) {
      server.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

function handleSSE(): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial data
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "init", logs: globalThis.requestLogs })}\n\n`));

      // Send updates every 2 seconds
      const interval = setInterval(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "update", time: Date.now(), logs: globalThis.requestLogs.slice(0, 10) })}\n\n`));
      }, 2000);

      // Cleanup on close
      return () => clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const INTERACTIVE_DASHBOARD = `
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root { --bg: #0b0f19; --panel: #151b2b; --border: #2d3748; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --success: #10b981; --error: #ef4444; --warning: #f59e0b; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: var(--bg); color: var(--text); padding: 20px; line-height: 1.6; }
.container { max-width: 1400px; margin: 0 auto; }
header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 2rem; border-radius: 12px; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: center; }
h1 { font-size: 2rem; }
.connection-status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); }
.dot.connected { background: var(--success); box-shadow: 0 0 10px var(--success); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; }
.panel h2 { color: var(--accent); margin-bottom: 1rem; font-size: 1.1rem; text-transform: uppercase; letter-spacing: 0.05em; }
.method-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
.method-tab { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.875rem; }
.method-tab.active { background: var(--accent); border-color: var(--accent); }
.method-tab.get.active { background: var(--success); border-color: var(--success); }
.method-tab.post.active { background: var(--warning); border-color: var(--warning); color: #000; }
.method-tab.delete.active { background: var(--error); border-color: var(--error); }
input, textarea { width: 100%; padding: 0.75rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; margin-bottom: 0.75rem; font-family: monospace; font-size: 0.9rem; }
input:focus, textarea:focus { outline: none; border-color: var(--accent); }
button { background: var(--accent); color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; cursor: pointer; font-weight: 600; width: 100%; }
button:hover { opacity: 0.9; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.response-viewer { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1rem; font-family: monospace; font-size: 0.85rem; overflow-x: auto; white-space: pre-wrap; max-height: 400px; overflow-y: auto; position: relative; }
.response-meta { display: flex; gap: 1rem; margin-bottom: 0.5rem; font-size: 0.8rem; color: var(--muted); }
.logs-container { max-height: 300px; overflow-y: auto; }
.log-item { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; margin-bottom: 0.5rem; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
.log-method { font-weight: bold; padding: 0.2rem 0.5rem; border-radius: 3px; font-size: 0.75rem; }
.log-method.GET { background: rgba(16, 185, 129, 0.2); color: var(--success); }
.log-method.POST { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
.log-method.DELETE { background: rgba(239, 68, 68, 0.2); color: var(--error); }
.log-time { color: var(--muted); font-size: 0.8rem; }
.clear-btn { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 0.5rem; font-size: 0.8rem; margin-top: 0.5rem; width: auto; }
.clear-btn:hover { border-color: var(--error); color: var(--error); }
.json-key { color: #93c5fd; }
.json-string { color: #a5d6ff; }
.json-number { color: #fca5a5; }
</style>
🚀 Interactive CORS Proxy
Zero-config proxy with real-time WebSocket console
<div class="connection-status">
    <span id="wsDot" class="dot"></span>
    <span id="wsText">Disconnected</span>
</div>
<div class="grid">
    <div class="panel">
        <h2>Request Builder</h2>
        <div class="method-tabs">
            <button class="method-tab active" data-method="GET">GET</button>
            <button class="method-tab" data-method="POST">POST</button>
            <button class="method-tab" data-method="PUT">PUT</button>
            <button class="method-tab" data-method="DELETE">DELETE</button>
            <button class="method-tab" data-method="PATCH">PATCH</button>
        </div>
        <input type="text" id="urlInput" placeholder="https://api.example.com/data" value="">
        <textarea id="headersInput" placeholder='{"Authorization": "Bearer token", "Content-Type": "application/json"}' rows="3"></textarea>
        <textarea id="bodyInput" placeholder='{"key": "value"}' rows="5" style="display:none;"></textarea>
        <button id="sendBtn" onclick="sendRequest()">Send Request</button>
        <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border);">
            <h3 style="color: var(--muted); font-size: 0.875rem; margin-bottom: 0.5rem;">Or use direct URL:</h3>
            <code style="background: var(--bg); padding: 0.5rem; border-radius: 4px; font-size: 0.8rem;"> /proxy?url=https://api.example.com/data </code>
        </div>
    </div>
    <div class="panel">
        <h2>Response</h2>
        <div class="response-meta" id="responseMeta"></div>
        <div class="response-viewer" id="responseViewer">
            <span style="color: var(--muted);">Waiting for request...</span>
        </div>
    </div>
</div>
<div class="panel" style="margin-top: 1.5rem;">
    <h2>Recent Requests <span style="color: var(--muted); font-size: 0.8rem; font-weight: normal;">(Live via WebSocket)</span></h2>
    <div class="logs-container" id="logsContainer">
        <div style="color: var(--muted); text-align: center; padding: 2rem;">
            Connect to WebSocket to see live logs...
        </div>
    </div>
    <button class="clear-btn" onclick="clearLogs()">Clear Logs</button>
</div>
</div>

<script>
    let ws;
    let currentMethod = 'GET';
    let logs = [];

    // Connect WebSocket
    function connectWS() {
        const wsUrl = 'wss://' + window.location.host + '/ws';
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            document.getElementById('wsDot').classList.add('connected');
            document.getElementById('wsText').textContent = 'Connected';
            ws.send(JSON.stringify({type: 'getLogs'}));
        };

        ws.onclose = () => {
            document.getElementById('wsDot').classList.remove('connected');
            document.getElementById('wsText').textContent = 'Disconnected';
            setTimeout(connectWS, 3000); // Attempt to reconnect after 3 seconds
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleWSMessage(data);
        };
    }

    function handleWSMessage(data) {
        if (data.type === 'response') {
            displayResponse(data);
        } else if (data.type === 'logs') {
            logs = data.data;
            renderLogs();
        } else if (data.type === 'error') {
            document.getElementById('responseViewer').innerHTML = '<span style="color: var(--error);">Error: ' + data.message + '</span>';
        }
    }

    function displayResponse(data) {
        const meta = document.getElementById('responseMeta');
        meta.innerHTML = `
            <span>Status: <strong style="color: ${data.status < 400 ? 'var(--success)' : 'var(--error)'}">${data.status}</strong></span>
            <span>Time: ${data.duration}</span>
            <span>Size: ${(data.size / 1024).toFixed(2)} KB</span>
        `;

        let body = data.body;
        try {
            const parsed = JSON.parse(body);
            body = JSON.stringify(parsed, null, 2);
            body = syntaxHighlight(body);
        } catch(e) {
            // Keep as string if not JSON
        }
        document.getElementById('responseViewer').innerHTML = body;
    }

    function syntaxHighlight(json) {
        return json.replace(/(\"(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\\"])*\"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function (match) {
            let cls = 'json-number';
            if (/^\"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'json-key';
                } else {
                    cls = 'json-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'json-boolean';
            }
            return '<span class="' + cls + '">' + match + '</span>';
        });
    }

    function sendRequest() {
        const url = document.getElementById('urlInput').value;
        if (!url) return alert('Please enter a URL');

        const headers = document.getElementById('headersInput').value;
        const body = document.getElementById('bodyInput').value;

        document.getElementById('responseViewer').innerHTML = '<span style="color: var(--accent);">Loading...</span>';

        ws.send(JSON.stringify({
            type: 'proxy',
            url: url,
            method: currentMethod,
            headers: headers ? JSON.parse(headers) : {},
            body: body ? JSON.parse(body) : undefined
        }));
    }

    function renderLogs() {
        const container = document.getElementById('logsContainer');
        if (logs.length === 0) {
            container.innerHTML = '<div style="color: var(--muted); text-align: center;">No requests yet</div>';
            return;
        }

        container.innerHTML = logs.map(log => `
            <div class="log-item">
                <div>
                    <span class="log-method ${log.method}">${log.method}</span>
                    <span style="margin-left: 0.5rem;">${log.target.substring(0, 60)}${log.target.length > 60 ? '...' : ''}</span>
                </div>
                <div style="text-align: right;">
                    <div style="color: ${log.status < 400 ? 'var(--success)' : 'var(--error)'}; font-weight: bold;"> ${log.status} </div>
                    <div class="log-time">${log.duration}ms • ${new Date(log.timestamp).toLocaleTimeString()}</div>
                </div>
            </div>
        `).join('');
    }

    function clearLogs() {
        ws.send(JSON.stringify({type: 'clearLogs'}));
    }

    // Method tabs
    document.querySelectorAll('.method-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.method-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentMethod = tab.dataset.method;

            // Show/hide body input
            document.getElementById('bodyInput').style.display = ['GET', 'HEAD'].includes(currentMethod) ? 'none' : 'block';
        });
    });

    // Initialize
    connectWS();

    // Set default URL from query params
    const params = new URLSearchParams(window.location.search);
    const defaultUrl = params.get('url');
    if (defaultUrl) {
        document.getElementById('urlInput').value = defaultUrl;
    }
</script>
`;
