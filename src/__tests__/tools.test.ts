import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test tool logic by importing tools and mocking the typora module.
// Since ESM mocking is complex, we test via the callTool interface
// with dependency injection patterns.

// Helper to parse content text from MCP result
function parseContent(result: { content: Array<{ type: string; text: string }> }): unknown {
  const text = result.content[0]?.text;
  if (!text) throw new Error("No content text");
  return JSON.parse(text);
}

describe("getDiagnostics tool", () => {
  it("returns empty diagnostics array", async () => {
    const { callTool } = await import("../tools.js");
    const result = await callTool("getDiagnostics", {});
    assert.ok(!result.isError);
    const data = parseContent(result) as { diagnostics: unknown[] };
    assert.deepEqual(data.diagnostics, []);
  });
});

describe("getToolList", () => {
  it("returns the 5 visible tools (getCurrentFile and getCurrentSelection are hidden)", async () => {
    const { getToolList } = await import("../tools.js");
    const tools = getToolList();
    const names = tools.map((t) => t.name);
    // Hidden tools must not appear
    assert.ok(!names.includes("getCurrentFile"), "getCurrentFile should be hidden");
    assert.ok(!names.includes("getCurrentSelection"), "getCurrentSelection should be hidden");
    // Standard tools must be present
    assert.ok(names.includes("getDiagnostics"));
    assert.ok(names.includes("getOpenEditors"));
    assert.ok(names.includes("getWorkspaceFolders"));
    assert.ok(names.includes("openFile"));
    assert.ok(names.includes("closeAllDiffTabs"));
    assert.equal(tools.length, 5);
  });

  it("each tool has name, description, and inputSchema", async () => {
    const { getToolList } = await import("../tools.js");
    const tools = getToolList();
    for (const tool of tools) {
      assert.ok(typeof tool.name === "string" && tool.name.length > 0, `${tool.name} missing name`);
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} missing description`);
      assert.ok(typeof tool.inputSchema === "object" && tool.inputSchema !== null, `${tool.name} missing inputSchema`);
    }
  });
});

describe("callTool error handling", () => {
  it("unknown tool returns isError with error message", async () => {
    const { callTool } = await import("../tools.js");
    const result = await callTool("completelyfaketool", {});
    assert.equal(result.isError, true);
    assert.ok(result.content[0]?.text.includes("completelyfaketool"));
  });

  it("result content is always an array with type:text", async () => {
    const { callTool } = await import("../tools.js");
    const result = await callTool("getDiagnostics", {});
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    assert.ok(typeof result.content[0]?.text === "string");
  });
});

describe("openFile tool validation", () => {
  it("returns error when filePath is missing", async () => {
    const { callTool } = await import("../tools.js");
    const result = await callTool("openFile", {});
    assert.equal(result.isError, true);
  });
});

describe("closeAllDiffTabs tool", () => {
  it("returns success with no isError", async () => {
    const { callTool } = await import("../tools.js");
    const result = await callTool("closeAllDiffTabs", {});
    assert.ok(!result.isError);
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
  });
});

describe("getDiagnostics tool with uri", () => {
  it("returns empty diagnostics regardless of uri argument", async () => {
    const { callTool } = await import("../tools.js");
    const result = await callTool("getDiagnostics", { uri: "file:///some/file.md" });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0]!.text) as { diagnostics: unknown[] };
    assert.deepEqual(data.diagnostics, []);
  });
});
