import { createServer } from "./server.js";
import { writeLockFile, deleteLockFile, getLockFilePath } from "./lockfile.js";
import { getFrontDocumentPath, findWorkspaceRoot } from "./typora.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

function parseArgs(argv: string[]): { workspace?: string; verbose: boolean } {
  const args = argv.slice(2);
  let workspace: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspace = args[++i];
    } else if (args[i] === "--verbose" || args[i] === "-v") {
      verbose = true;
    }
  }

  return { workspace, verbose };
}

async function detectWorkspace(specifiedWorkspace?: string): Promise<string[]> {
  if (specifiedWorkspace) {
    return [resolve(specifiedWorkspace)];
  }

  // cwd is always included — it's what `claude /ide` matches against
  const cwd = process.cwd();
  const workspaces = new Set<string>([cwd]);

  // Also include the workspace root (git root, or parent dir) of whatever Typora has open,
  // unless it's a temp directory.
  const filePath = await getFrontDocumentPath();
  if (filePath) {
    const tmp = tmpdir();
    const normalizedFilePath = filePath.replace(/^\/private/, "");
    const normalizedTmp = tmp.replace(/^\/private/, "");
    if (!normalizedFilePath.startsWith(normalizedTmp)) {
      const wsRoot = await findWorkspaceRoot(filePath);
      workspaces.add(wsRoot);
    }
  }

  return [...workspaces];
}

async function main() {
  const { workspace, verbose } = parseArgs(process.argv);

  const authToken = crypto.randomUUID();
  const workspaceFolders = await detectWorkspace(workspace);

  const server = await createServer({ authToken, verbose });
  const { port } = server;

  await writeLockFile(port, workspaceFolders, authToken);

  // Print connection info for debugging / scripting
  console.log(`Typora Claude Bridge running`);
  console.log(`Port: ${port}`);
  console.log(`Auth Token: ${authToken}`);
  if (workspaceFolders.length > 0) {
    console.log(`Workspace: ${workspaceFolders.join(", ")}`);
  }

  async function cleanup() {
    await deleteLockFile(port);
    await server.close();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => {
    // Synchronous best-effort cleanup for ungraceful exits (e.g. SIGKILL)
    try {
      unlinkSync(getLockFilePath(port));
    } catch {
      // Ignore — already deleted or never created
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
