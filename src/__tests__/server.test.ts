import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createServer } from "../server.js";
import type { BridgeServer } from "../server.js";

const AUTH_TOKEN = "test-auth-token-12345";

function wsConnect(port: number, token?: string): WebSocket {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["x-claude-code-ide-authorization"] = token;
  }
  return new WebSocket(`ws://127.0.0.1:${port}`, { headers });
}

async function wsRequest(
  ws: WebSocket,
  msg: object
): Promise<object> {
  return new Promise((resolve, reject) => {
    // The server may push notifications (e.g. selection_changed) before responding.
    // Keep listening until we receive a message that has an `id` field (a response).
    const onMessage = (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if ("id" in parsed) {
          ws.off("message", onMessage);
          resolve(parsed);
        }
        // else: it's a notification, keep waiting
      } catch (e) {
        ws.off("message", onMessage);
        reject(e);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(msg));
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

describe("server protocol", () => {
  let server: BridgeServer;

  before(async () => {
    server = await createServer({ authToken: AUTH_TOKEN });
  });

  after(async () => {
    await server.close();
  });

  it("rejects connection with no auth token", async () => {
    const ws = wsConnect(server.port);
    const code = await waitForClose(ws);
    assert.equal(code, 4001);
  });

  it("rejects connection with wrong auth token", async () => {
    const ws = wsConnect(server.port, "wrong-token");
    const code = await waitForClose(ws);
    assert.equal(code, 4001);
  });

  it("accepts connection with correct auth token", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it("initialize returns correct protocol version and capabilities", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }) as Record<string, unknown>;
    assert.equal(resp["jsonrpc"], "2.0");
    assert.equal(resp["id"], 1);
    const result = resp["result"] as Record<string, unknown>;
    assert.equal(result["protocolVersion"], "2024-11-05");
    assert.ok(result["capabilities"]);
    const caps = result["capabilities"] as Record<string, unknown>;
    assert.ok(caps["tools"]);
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    assert.equal(serverInfo["name"], "typora-bridge");
    ws.close();
  });

  it("ping returns empty result", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    }) as Record<string, unknown>;
    assert.equal(resp["id"], 99);
    assert.deepEqual(resp["result"], {});
    ws.close();
  });

  it("tools/list returns array of tools with schemas", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }) as Record<string, unknown>;
    const result = resp["result"] as Record<string, unknown>;
    const tools = result["tools"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.ok(typeof tool["name"] === "string");
      assert.ok(typeof tool["description"] === "string");
      assert.ok(tool["inputSchema"]);
    }
    ws.close();
  });

  it("tools/call getDiagnostics returns MCP content format", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "getDiagnostics", arguments: {} },
    }) as Record<string, unknown>;
    assert.equal(resp["id"], 3);
    const result = resp["result"] as Record<string, unknown>;
    const content = result["content"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(content));
    assert.equal(content[0]?.["type"], "text");
    assert.ok(typeof content[0]?.["text"] === "string");
    ws.close();
  });

  it("tools/call unknown tool returns isError", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nonExistentTool", arguments: {} },
    }) as Record<string, unknown>;
    const result = resp["result"] as Record<string, unknown>;
    assert.equal(result["isError"], true);
    ws.close();
  });

  it("malformed JSON returns -32700 parse error", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    // Parse errors produce a response with id:null — use wsRequest with a sentinel
    const resp = await new Promise<object>((resolve, reject) => {
      const onMsg = (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          if ("error" in parsed) { ws.off("message", onMsg); resolve(parsed); }
        } catch (e) { ws.off("message", onMsg); reject(e); }
      };
      ws.on("message", onMsg);
      ws.send("not valid json {{{");
    }) as Record<string, unknown>;
    const error = resp["error"] as Record<string, unknown>;
    assert.equal(error["code"], -32700);
    ws.close();
  });

  it("missing method field returns -32600 invalid request", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, { jsonrpc: "2.0", id: 5 }) as Record<string, unknown>;
    const error = resp["error"] as Record<string, unknown>;
    assert.equal(error["code"], -32600);
    ws.close();
  });

  it("unknown method returns -32601 method not found", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 6,
      method: "unknown/method",
    }) as Record<string, unknown>;
    const error = resp["error"] as Record<string, unknown>;
    assert.equal(error["code"], -32601);
    ws.close();
  });

  it("ide_connected returns empty result", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 8,
      method: "ide_connected",
      params: {},
    }) as Record<string, unknown>;
    assert.equal(resp["id"], 8);
    assert.deepEqual(resp["result"], {});
    ws.close();
  });

  it("closeAllDiffTabs returns success", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "closeAllDiffTabs", arguments: {} },
    }) as Record<string, unknown>;
    const result = resp["result"] as Record<string, unknown>;
    assert.ok(!result["isError"], "closeAllDiffTabs should succeed");
    ws.close();
  });

  it("selection_changed notification is pushed on connect", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    // The server pushes selection_changed immediately after authentication.
    // Wait for the first incoming message (the notification).
    const msg = await new Promise<object>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for selection_changed")), 3000);
      ws.once("message", (data) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
      });
    }) as Record<string, unknown>;
    assert.equal(msg["method"], "selection_changed");
    const params = msg["params"] as Record<string, unknown>;
    assert.ok("filePath" in params, "params.filePath should exist");
    assert.ok("fileUrl" in params, "params.fileUrl should exist");
    assert.ok("text" in params, "params.text should exist");
    assert.ok("selection" in params, "params.selection should exist");
    const sel = params["selection"] as Record<string, unknown>;
    assert.ok("isEmpty" in sel, "selection.isEmpty should exist");
    ws.close();
  });

  it("selection_changed is pushed on connect (event-based wait)", async () => {
    const fastServer = await createServer({ authToken: AUTH_TOKEN + "-fast", pollIntervalMs: 100 });
    const ws = wsConnect(fastServer.port, AUTH_TOKEN + "-fast");

    // Wait for the first selection_changed notification using a promise, not a fixed delay.
    const notification = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout: no selection_changed received")), 5000);
      const onMsg = (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["method"] === "selection_changed") {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(msg);
        }
      };
      ws.on("message", onMsg);
      // Also connect after setting up listener, so we don't miss the push
    });

    assert.equal(notification["method"], "selection_changed");
    ws.close();
    await fastServer.close();
  });

  it("notifications/initialized gets no response", async () => {
    const ws = wsConnect(server.port, AUTH_TOKEN);
    await waitForOpen(ws);
    // Send notification, then ping to verify server is still alive
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    // Now send ping - should get ping response (not a response to the notification)
    const resp = await wsRequest(ws, {
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
    }) as Record<string, unknown>;
    assert.equal(resp["id"], 7);
    assert.deepEqual(resp["result"], {});
    ws.close();
  });
});
