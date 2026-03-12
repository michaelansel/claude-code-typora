/**
 * Integration tests that require Typora running.
 * Run with: npm run test:integration
 *
 * The before() hook creates a fixture .md file and opens it in Typora,
 * giving every test a clean, known starting state regardless of what
 * Typora had open before.  The after() hook closes it and deletes it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  getFrontDocumentPath,
  getDocuments,
  openInTypora,
} from "../typora.js";
import { createServer } from "../server.js";
import { writeLockFile, deleteLockFile } from "../lockfile.js";

function skip(reason: string) {
  console.log(`  SKIP: ${reason}`);
}

async function isTyporaRunning(): Promise<boolean> {
  return (await getFrontDocumentPath()) !== null || (await getDocuments()).length > 0;
}

async function wsConnect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { "x-claude-code-ide-authorization": token },
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function wsRequest(ws: WebSocket, msg: object): Promise<object> {
  return new Promise((resolve, reject) => {
    // Skip push notifications (no id field); wait for an actual response.
    const onMessage = (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if ("id" in parsed) {
          ws.off("message", onMessage);
          resolve(parsed);
        }
      } catch (e) {
        ws.off("message", onMessage);
        reject(e);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(msg));
  });
}

describe("integration: Typora running", () => {
  let fixtureDir: string;
  let fixtureFile: string;
  const fixtureContent = "# Bridge Integration Test\n\nThis file is created by the test suite.\n";

  before(async () => {
    if (!(await isTyporaRunning())) return;
    // Create a fixture file with a known path (resolved canonical path)
    fixtureDir = await realpath(await mkdtemp(join(tmpdir(), "typora-bridge-fixture-")));
    fixtureFile = join(fixtureDir, "fixture.md");
    await writeFile(fixtureFile, fixtureContent, "utf-8");
    // Open it in Typora and wait for it to become the front document
    openInTypora(fixtureFile);
    await new Promise((r) => setTimeout(r, 1500));
  });

  after(async () => {
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("getFrontDocumentPath returns the fixture file path", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");
    const filePath = await getFrontDocumentPath();
    if (!filePath) return skip("No file open in Typora");
    assert.equal(filePath, fixtureFile, `Expected front doc to be fixture: ${fixtureFile}, got: ${filePath}`);
  });

  it("getDocuments returns non-empty array with name and path", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");
    const docs = await getDocuments();
    if (docs.length === 0) return skip("No documents open in Typora");
    assert.ok(docs.length > 0);
    for (const doc of docs) {
      assert.ok(typeof doc.name === "string");
      assert.ok(typeof doc.path === "string");
    }
    // Fixture should be in the list
    const found = docs.some((d) => d.path === fixtureFile);
    assert.ok(found, `Fixture file should appear in document list`);
  });

  it("full round-trip: bridge → WebSocket → initialize + tools/list", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");

    const authToken = crypto.randomUUID();
    const server = await createServer({ authToken });
    await writeLockFile(server.port, [], authToken);
    let ws: WebSocket | undefined;

    try {
      ws = await wsConnect(server.port, authToken);

      const initResp = await wsRequest(ws, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }) as Record<string, unknown>;
      assert.equal((initResp["result"] as Record<string, unknown>)["protocolVersion"], "2024-11-05");

      const listResp = await wsRequest(ws, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) as Record<string, unknown>;

      const result = listResp["result"] as Record<string, unknown>;
      const tools = result["tools"] as Array<{ name: string }>;
      assert.ok(Array.isArray(tools) && tools.length === 5);
    } finally {
      ws?.terminate();
      await deleteLockFile(server.port);
      await server.close();
    }
  });

  it("openFile tool opens a new temp markdown file in Typora", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");

    const testDir = await realpath(await mkdtemp(join(tmpdir(), "typora-bridge-inttest-")));
    const testFile = join(testDir, "test-open.md");
    await writeFile(testFile, "# openFile test\n", "utf-8");

    const authToken = crypto.randomUUID();
    const server = await createServer({ authToken });
    let ws: WebSocket | undefined;

    try {
      ws = await wsConnect(server.port, authToken);
      const resp = await wsRequest(ws, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "openFile", arguments: { filePath: testFile } },
      }) as Record<string, unknown>;

      const result = resp["result"] as Record<string, unknown>;
      assert.ok(!result["isError"], `openFile returned error: ${JSON.stringify(result)}`);

      await new Promise((r) => setTimeout(r, 1000));

      const docs = await getDocuments();
      const opened = docs.some((d) => d.path === testFile);
      assert.ok(opened, "Typora should have opened the test file");
    } finally {
      ws?.terminate();
      await server.close();
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("selection_changed is pushed immediately on connect with correct shape", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");

    const authToken = crypto.randomUUID();
    const server = await createServer({ authToken });
    let ws: WebSocket | undefined;

    try {
      ws = await wsConnect(server.port, authToken);

      const notification = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 3000);
        ws!.once("message", (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(data.toString()));
        });
      });

      assert.equal(notification["method"], "selection_changed");
      const params = notification["params"] as Record<string, unknown>;
      assert.ok(typeof params["filePath"] === "string", "params.filePath should be a string");
      const fp = params["filePath"] as string;
      assert.ok(fp.length === 0 || fp.startsWith("/"), "filePath should be empty or absolute");
      assert.equal(params["fileUrl"], fp ? `file://${fp}` : "");
      assert.ok(typeof params["text"] === "string");
      const sel = params["selection"] as Record<string, unknown>;
      assert.ok(typeof sel["isEmpty"] === "boolean");
    } finally {
      ws?.terminate();
      await server.close();
    }
  });

  it("getOpenEditors returns array with uri and languageId", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");
    const { callTool } = await import("../tools.js");
    const result = await callTool("getOpenEditors", {});
    assert.ok(!result.isError);
    const editors = JSON.parse(result.content[0]!.text) as Array<{ uri: string; languageId: string }>;
    assert.ok(Array.isArray(editors));
    // Fixture should be in the list
    const found = editors.some((e) => e.uri === `file://${fixtureFile}`);
    assert.ok(found, "fixture file should appear in open editors");
    for (const e of editors) {
      assert.ok(e.uri.startsWith("file://"), "uri should be a file URI");
      assert.equal(e.languageId, "markdown");
    }
  });

  it("getWorkspaceFolders returns parent dir of fixture file", async () => {
    if (!(await isTyporaRunning())) return skip("Typora not running");
    const { callTool } = await import("../tools.js");
    const result = await callTool("getWorkspaceFolders", {});
    assert.ok(!result.isError);
    const folders = JSON.parse(result.content[0]!.text) as Array<{ uri: string; name: string }>;
    assert.ok(Array.isArray(folders));
    assert.ok(folders.length > 0);
    for (const f of folders) {
      assert.ok(f.uri.startsWith("file://"), "uri should be a file URI");
      assert.ok(typeof f.name === "string" && f.name.length > 0);
    }
  });
});
