# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # compile TypeScript → dist/
npm test               # run unit tests (no Typora required)
npm start              # run the bridge (tsx, no build needed)
npm start -- --verbose # run with JSON-RPC traffic logged to stderr
npm run test:integration  # integration tests (requires Typora running)
```

Run a single test file:
```bash
node --test dist/__tests__/server.test.js
```

## Architecture

The bridge is a single Node.js process that Claude Code discovers via a lock file.

**Discovery**: On startup, `src/index.ts` writes `~/.claude/ide/{port}.lock` (JSON with `pid`, `workspaceFolders`, `ideName`, `transport: "ws"`, `authToken`). Claude Code's `/ide` command scans this directory to find running bridges.

**Transport**: `src/server.ts` runs a WebSocket server on `127.0.0.1:0` (OS-assigned port). Every connection is authenticated by checking the `x-claude-code-ide-authorization` header against the auth token from the lock file. All messages are JSON-RPC 2.0.

**Push notifications**: The server polls `getFrontDocumentPath()` every 2 seconds (lightweight JXA, no side effects). When the active file changes, it broadcasts a `selection_changed` notification to all connected clients. Claude Code uses this to know what file is open — it does not pull this information via tools.

**Tools** (`src/tools.ts`): Five tools are exposed via `tools/list`:
- `getDiagnostics` — always returns `[]` (Typora has no LSP)
- `getOpenEditors` — lists all open Typora documents via JXA
- `getWorkspaceFolders` — parent directory of the front document
- `openFile` — fire-and-forget `open -a Typora <path>`
- `closeAllDiffTabs` — no-op (Claude Code calls this on every connect)

**Typora interaction** (`src/typora.ts`): All Typora introspection uses JXA (JavaScript for Automation) via `osascript`. No clipboard manipulation or keypress injection anywhere in the codebase.

**Tests**: Unit tests in `src/__tests__/` use `node:test` + `node:assert`. The server and tools tests run against a real WebSocket server but mock Typora by not requiring it to be running. Integration tests (`integration.test.ts`) are excluded from `npm test` and require Typora to be open.
