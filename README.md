# claude-code-typora

A [Claude Code](https://claude.ai/claude-code) IDE bridge for [Typora](https://typora.io). Lets Claude Code see which file you have open in Typora and open files in Typora on your behalf.

## Requirements

- macOS (uses JXA / osascript)
- [Node.js](https://nodejs.org) 20+
- Typora
- Claude Code

## Install

```bash
git clone https://github.com/michaelansel/claude-code-typora.git
cd claude-code-typora
npm install
npm run build
```

## Usage

Start the bridge before (or after) opening Claude Code:

```bash
npm start
```

Then in Claude Code, run `/ide` and select **Typora**. Claude will now know which file you have open.

### Options

```
--verbose    Print JSON-RPC traffic to stderr
--workspace  Override the workspace folder (default: cwd + git root of open file)
```

### Auto-start (optional)

To have the bridge start automatically when you log in, add a launchd plist:

```bash
cat > ~/Library/LaunchAgents/com.typora.claude-bridge.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.typora.claude-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>$(pwd)/dist/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>/tmp/typora-claude-bridge.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.typora.claude-bridge.plist
```

## How it works

The bridge runs a local WebSocket server and writes a lock file to `~/.claude/ide/` so Claude Code's `/ide` command can discover it. When Claude Code connects, the bridge:

- Tells Claude which file Typora has open (and updates it as you switch files)
- Responds to tool calls: `getDiagnostics`, `getOpenEditors`, `getWorkspaceFolders`, `openFile`, `closeAllDiffTabs`

## Development

```bash
npm test               # unit tests (no Typora required)
npm run test:integration   # integration tests (requires Typora running)
```
