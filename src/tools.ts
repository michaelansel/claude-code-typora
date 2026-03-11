import { readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import {
  getFrontDocumentPath,
  getDocuments,
  openInTypora,
} from "./typora.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function successResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// hidden: true tools are kept for callTool routing but not exposed in tools/list.
// Selection and file content are delivered via selection_changed push notifications.
const tools: Array<ToolDefinition & { handler: ToolHandler; hidden?: boolean }> = [
  {
    name: "getCurrentFile",
    hidden: true,
    description: "Get the path and content of the currently active file in Typora",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const filePath = await getFrontDocumentPath();
      if (!filePath) return errorResult("Error: No file is currently open in Typora");
      const content = await readFile(filePath, "utf-8");
      return successResult({ filePath, content, languageId: "markdown" });
    },
  },
  {
    name: "getCurrentSelection",
    hidden: true,
    description: "Get the currently selected text in Typora",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      // Selection is pushed via selection_changed; this pull path is kept as fallback.
      return errorResult("Use the selection context provided automatically via selection_changed notifications.");
    },
  },
  {
    name: "getDiagnostics",
    description:
      "Get diagnostics (errors/warnings) for the current file. Typora has no LSP, so this always returns an empty list.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "URI of the file (optional)" },
      },
      required: [],
    },
    handler: async () => successResult({ diagnostics: [] }),
  },
  {
    name: "getOpenEditors",
    description: "Get a list of all open documents in Typora",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const docs = await getDocuments();
      const editors = docs
        .filter((d) => d.path)
        .map((d) => ({ uri: `file://${d.path}`, languageId: "markdown" }));
      return successResult(editors);
    },
  },
  {
    name: "getWorkspaceFolders",
    description: "Get the workspace folders (parent directory of the current file)",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const filePath = await getFrontDocumentPath();
      if (!filePath) return successResult([]);
      const parentDir = dirname(filePath);
      const name = basename(parentDir);
      return successResult([{ uri: `file://${parentDir}`, name }]);
    },
  },
  {
    name: "openFile",
    description: "Open a file in Typora",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to open" },
        line: { type: "number", description: "Line number (not supported by Typora)" },
        startText: { type: "string", description: "Start text (not supported by Typora)" },
        endText: { type: "string", description: "End text (not supported by Typora)" },
      },
      required: ["filePath"],
    },
    handler: async (args) => {
      const filePath = args["filePath"] as string;
      if (!filePath) return errorResult("Error: filePath is required");
      openInTypora(filePath);
      return successResult({});
    },
  },
  {
    // Claude Code calls this on every IDE connection to clean up diff views.
    // Typora has no diff views, so we just acknowledge it.
    name: "closeAllDiffTabs",
    description: "Close all diff tabs (no-op in Typora)",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => successResult({}),
  },
];

export function getToolList(): ToolDefinition[] {
  return tools
    .filter((t) => !t.hidden)
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return errorResult(`Error: Unknown tool "${name}"`);
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
