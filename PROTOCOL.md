# Claude Code IDE Integration Protocol Reference

> Reverse-engineered from VS Code extension (v2.1.72), claudecode.nvim, claude-code-ide.el,
> and the MCP specification (2024-11-05). This documents the full protocol as implemented
> by the official IDE integrations, not just what this bridge implements.

## Discovery: Lock Files

Claude Code's `/ide` command scans `~/.claude/ide/*.lock` to find running IDE bridges.

**Path**: `~/.claude/ide/{port}.lock` (port = WebSocket listen port)

**Format** (from real VS Code lock file):
```json
{
  "pid": 77520,
  "workspaceFolders": ["/Users/michael/Code/project"],
  "ideName": "Visual Studio Code",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "adaca1cd-dd1d-452a-8fad-19c3e208711a"
}
```

**Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `pid` | number | Process ID of the bridge/IDE |
| `workspaceFolders` | string[] | Array of workspace directory paths (can be empty) |
| `ideName` | string | IDE identifier: "Visual Studio Code", "Emacs", "Neovim", "Typora", etc. |
| `transport` | string | Always `"ws"` for WebSocket |
| `runningInWindows` | boolean | Platform indicator |
| `authToken` | string | UUID v4 for WebSocket authentication |

**Environment variable alternative** (when IDE launches the terminal):
- `CLAUDE_CODE_SSE_PORT` / `CLAUDE_IDE_PORT` — WebSocket port
- `CLAUDE_IDE_AUTH_TOKEN` — Auth token
- `ENABLE_IDE_INTEGRATION=true` — Activates integration
- `TERM_PROGRAM=<editor>` — IDE identifier

## Transport: WebSocket

- Server listens on `127.0.0.1:{port}` (localhost only)
- Standard WebSocket (RFC 6455) with text frames carrying JSON-RPC 2.0 messages
- Authentication via HTTP upgrade header: `x-claude-code-ide-authorization: {authToken}`
- Server must reject unauthenticated connections with `ws.close(4001, 'Unauthorized')`
- CVE-2025-52882: pre-patch versions had no auth; all new implementations MUST verify tokens

## Protocol: JSON-RPC 2.0 over MCP

### Connection Handshake

1. Client (Claude Code) connects to WebSocket with auth header
2. Client sends `initialize` request
3. Server responds with capabilities
4. Client sends `notifications/initialized` notification
5. Client calls `tools/list` to discover available tools
6. Normal operation: client calls `tools/call` as needed

### Protocol Version Negotiation

- Client sends `"protocolVersion": "2025-03-26"` in initialize
- Server responds with highest version it supports
- Safe to respond with `"2024-11-05"` — client will downgrade
- The `"2025-03-26"` streamable HTTP spec is not fully supported by all clients

---

## All JSON-RPC Methods

### Lifecycle (Base Protocol)

#### `initialize` — REQUIRED
Client sends first, server must respond.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "sampling": {},
      "elicitation": {},
      "roots": { "listChanged": true }
    },
    "clientInfo": { "name": "claude-code", "version": "1.0.0" }
  }
}
```

**Response (VS Code reference):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "prompts": { "listChanged": true },
      "logging": {}
    },
    "serverInfo": { "name": "claude-code-ide", "version": "0.1.0" }
  }
}
```

**Capabilities control what the client calls.** Only declare capabilities you implement:
- `tools` → client will call `tools/list`, `tools/call`
- `prompts` → client will call `prompts/list`, `prompts/get`
- `resources` → client will call `resources/list`, `resources/read`, `resources/templates/list`, `resources/subscribe`
- `logging` → client will call `logging/setLevel`

#### `notifications/initialized` — REQUIRED
Client sends after receiving `initialize` response. No `id` field (notification). No response.

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

#### `ping` — REQUIRED
Either direction. Must respond with empty result.

**Request:** `{ "jsonrpc": "2.0", "id": N, "method": "ping" }`
**Response:** `{ "jsonrpc": "2.0", "id": N, "result": {} }`

---

### Tools

#### `tools/list` — REQUIRED (if `tools` capability declared)

**Request:** `{ "jsonrpc": "2.0", "id": N, "method": "tools/list", "params": {} }`

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "openFile",
        "description": "Opens files with optional line/text selection",
        "inputSchema": {
          "type": "object",
          "properties": {
            "filePath": { "type": "string", "description": "Path to the file" },
            "line": { "type": "number", "description": "Line number to scroll to" },
            "startText": { "type": "string" },
            "endText": { "type": "string" }
          },
          "required": ["filePath"]
        }
      }
    ]
  }
}
```

#### `tools/call` — REQUIRED (if `tools` capability declared)

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "getCurrentFile",
    "arguments": {}
  }
}
```

**Success response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "{\"filePath\":\"/path/to/file.md\",\"content\":\"...\"}" }
    ]
  }
}
```

**Error response (tool-level, not JSON-RPC error):**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "Error: Typora is not running" }
    ],
    "isError": true
  }
}
```

#### `notifications/tools/list_changed` — OPTIONAL (server→client)
Sent when tool list changes dynamically.
```json
{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }
```

---

### Prompts

#### `prompts/list` — REQUIRED (if `prompts` capability declared)
**Response:** `{ "jsonrpc": "2.0", "id": N, "result": { "prompts": [] } }`

#### `prompts/get` — REQUIRED (if `prompts` capability declared)
Return prompt content by name.

#### `notifications/prompts/list_changed` — OPTIONAL (server→client)

---

### Resources

Could expose open Typora files as resources in a future version.

#### `resources/list` — REQUIRED (if `resources` capability declared)
**Response:** `{ "jsonrpc": "2.0", "id": N, "result": { "resources": [] } }`

#### `resources/read` — REQUIRED (if `resources` capability declared)
#### `resources/templates/list` — OPTIONAL
#### `resources/subscribe` / `resources/unsubscribe` — OPTIONAL (if `resources.subscribe`)
#### `notifications/resources/list_changed` — OPTIONAL (server→client)
#### `notifications/resources/updated` — OPTIONAL (server→client)

---

### Logging

#### `logging/setLevel` — OPTIONAL (if `logging` capability declared)
Client requests a log level. Server sends `notifications/message` with log entries.

#### `notifications/message` — OPTIONAL (server→client)
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": { "level": "info", "data": "Bridge started on port 12345" }
}
```

---

### Utilities

#### `notifications/cancelled` — OPTIONAL
Either direction. Cancels a pending request.
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": { "requestId": 3, "reason": "User cancelled" }
}
```

#### `notifications/progress` — OPTIONAL
Server→client progress updates for long-running operations.

---

### Advanced: Server→Client Requests

These are requests the SERVER sends TO the CLIENT. Claude Code supports them if it declared the capability in the `initialize` request.

#### `sampling/createMessage`
Ask Claude to generate text (requires client declared `sampling` capability).

#### `roots/list`
Get workspace roots from Claude's context (requires client declared `roots` capability).

#### `elicitation/create`
Ask the user a question via Claude's UI (requires client declared `elicitation` capability).

---

## JSON-RPC Error Codes

| Code | Meaning | When to use |
|------|---------|-------------|
| -32700 | Parse error | Malformed JSON |
| -32600 | Invalid request | Missing `jsonrpc: "2.0"` or `method` |
| -32601 | Method not found | Unknown method name |
| -32602 | Invalid params | Bad parameters for known method |
| -32603 | Internal error | Unhandled server exception |

**Error response format:**
```json
{ "jsonrpc": "2.0", "id": N, "error": { "code": -32601, "message": "Method not found" } }
```

Note: For unknown methods, the `id` field may be null if the message was a notification (no `id`). Notifications never get responses, even error responses.

---

## Standard IDE Tools (VS Code Reference, 12 tools)

| Tool | Description | Implemented by this bridge? |
|------|-------------|----------------------------|
| `openFile` | Open file with optional line/selection | **Yes** |
| `getCurrentFile` | Get path + content of current file | **Yes** (not in VS Code — Typora-specific) |
| `getCurrentSelection` | Get active editor selection | **Yes** |
| `getDiagnostics` | Get LSP errors/warnings | **Yes** (stub, returns `[]`) |
| `getOpenEditors` | List open editor tabs | **Yes** |
| `getWorkspaceFolders` | List workspace folders | **Yes** |
| `openDiff` | Show diff view (blocking) | No — Typora has no diff view |
| `saveDocument` | Save a file | No — Typora auto-saves; risky via System Events |
| `close_tab` | Close editor tab | No — Cmd+W via System Events is dangerous |
| `closeAllDiffTabs` | Close all diff views | No — Typora has no diff view |
| `getLatestSelection` | Most recent selection (even if focus lost) | No — VS Code specific |
| `checkDocumentDirty` | Check if file has unsaved changes | No — not essential for v1 |
| `executeCode` | Run code in Jupyter kernel | No — VS Code + Jupyter specific |

### Tool Input/Output Schemas

**`openFile`:**
```
input:  { filePath: string, line?: number, startText?: string, endText?: string }
output: {} (opens the file, no meaningful return)
```

**`getCurrentFile`:**
```
input:  {}
output: { filePath: string, content: string, languageId: "markdown" }
```

**`getCurrentSelection`:**
```
input:  {}
output: { text: string, filePath: string | null, isEmpty: boolean }
```

**`getDiagnostics`:**
```
input:  { uri?: string }
output: { diagnostics: [] }
```

**`getOpenEditors`:**
```
input:  {}
output: [{ uri: string, languageId: string }]
```

**`getWorkspaceFolders`:**
```
input:  {}
output: [{ uri: string, name: string }]
```

---

## Non-Standard Extensions (VS Code Specific)

The VS Code extension sends custom non-MCP notifications:
- `selection_changed` — pushed when user selection changes in VS Code
- `at_mentioned` — when user sends selection as context via @ mention

These are not part of the MCP spec and not required for basic IDE integration.

---

## Useful References

- [MCP Specification 2024-11-05](https://spec.modelcontextprotocol.io/specification/2024-11-05/)
- [claude-code-ide.el (Emacs)](https://github.com/manzaltu/claude-code-ide.el) — Elisp reference implementation
- [claudecode.nvim (Neovim)](https://github.com/coder/claudecode.nvim) — TypeScript/Lua reference implementation
- [CVE-2025-52882](https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882/) — Documents auth token flow
- [GitHub issue #23119](https://github.com/anthropics/claude-code/issues/23119) — Reverse-engineered protocol details
