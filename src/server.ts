import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { getToolList, callTool } from "./tools.js";
import { getFrontDocumentPath } from "./typora.js";

export interface ServerOptions {
  authToken: string;
  verbose?: boolean;
  pollIntervalMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function response(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: number | string | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function selectionChangedNotification(filePath: string | null) {
  return {
    jsonrpc: "2.0",
    method: "selection_changed",
    params: {
      text: "",
      filePath: filePath ?? "",
      fileUrl: filePath ? `file://${filePath}` : "",
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
        isEmpty: true,
      },
    },
  };
}

async function handleRequest(
  req: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return response(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: { name: "typora-bridge", version: "0.1.0" },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications — no response
      return null;

    case "ide_connected":
      // Claude Code sends this after connecting; acknowledge with empty result
      return response(id, {});

    case "ping":
      return response(id, {});

    case "tools/list":
      return response(id, { tools: getToolList() });

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      if (!toolName) {
        return errorResponse(id, -32602, "Invalid params: missing tool name");
      }
      const result = await callTool(toolName, toolArgs);
      return response(id, result);
    }

    default:
      // Notifications (no id) get no response
      if (req.id === undefined) return null;
      return errorResponse(id, -32601, "Method not found");
  }
}

export interface BridgeServer {
  port: number;
  close(): Promise<void>;
}

export function createServer(options: ServerOptions): Promise<BridgeServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const clients = new Set<WebSocket>();
    const pollIntervalMs = options.pollIntervalMs ?? 2000;

    function broadcast(msg: object) {
      const data = JSON.stringify(msg);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    }

    // Poll Typora for active document changes every pollIntervalMs (lightweight JXA only).
    let lastFilePath: string | null | undefined = undefined;

    async function pollTypora() {
      try {
        const filePath = await getFrontDocumentPath();
        if (filePath !== lastFilePath) {
          lastFilePath = filePath;
          if (clients.size > 0) {
            broadcast(selectionChangedNotification(filePath));
          }
        }
      } catch {
        // Ignore poll errors
      }
    }
    const pollTimer = setInterval(pollTypora, pollIntervalMs);

    wss.on("error", reject);

    wss.on("listening", () => {
      const addr = wss.address() as { port: number };
      const port = addr.port;

      if (options.verbose) {
        console.error(`[typora-bridge] WebSocket server listening on port ${port}`);
      }

      wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        // Authenticate
        const authHeader = req.headers["x-claude-code-ide-authorization"];
        if (authHeader !== options.authToken) {
          ws.close(4001, "Unauthorized");
          return;
        }

        clients.add(ws);
        ws.on("close", () => clients.delete(ws));

        if (options.verbose) {
          console.error("[typora-bridge] Client connected");
        }

        // Push current file path immediately on connect.
        getFrontDocumentPath().then((filePath) => {
          lastFilePath = filePath;
          const notification = selectionChangedNotification(filePath);
          if (options.verbose) {
            console.error(`[typora-bridge] ⬆ selection_changed(${filePath})`);
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(notification));
          }
        }).catch(() => { /* ignore */ });

        ws.on("message", async (data: Buffer) => {
          let parsed: JsonRpcRequest;

          try {
            parsed = JSON.parse(data.toString());
          } catch {
            const err = errorResponse(null, -32700, "Parse error");
            ws.send(JSON.stringify(err));
            return;
          }

          // Validate JSON-RPC
          if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
            const id = parsed.id ?? null;
            const err = errorResponse(id, -32600, "Invalid Request");
            ws.send(JSON.stringify(err));
            return;
          }

          if (options.verbose) {
            const detail = parsed.method === "tools/call"
              ? `tools/call(${(parsed.params as Record<string, unknown>)?.["name"]})`
              : parsed.method;
            console.error(`[typora-bridge] → ${detail}`);
          }

          try {
            const result = await handleRequest(parsed);
            if (result !== null) {
              if (options.verbose) {
                const isError = (result.result as Record<string, unknown>)?.["isError"];
                const snippet = JSON.stringify(result).slice(0, 200);
                console.error(`[typora-bridge] ← ${isError ? "ERROR " : ""}${snippet}`);
              }
              ws.send(JSON.stringify(result));
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const errResp = errorResponse(parsed.id ?? null, -32603, `Internal error: ${message}`);
            if (options.verbose) {
              console.error(`[typora-bridge] ← INTERNAL ERROR: ${message}`);
            }
            ws.send(JSON.stringify(errResp));
          }
        });

        ws.on("close", () => {
          if (options.verbose) {
            console.error("[typora-bridge] Client disconnected");
          }
        });
      });

      resolve({
        port,
        close: () => {
          clearInterval(pollTimer);
          for (const client of clients) {
            client.terminate();
          }
          return new Promise((res, rej) =>
            wss.close((err) => (err ? rej(err) : res()))
          );
        },
      });
    });
  });
}
