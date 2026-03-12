import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

export async function runJxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
  ]);
  return stdout.trim();
}

export async function getFrontDocumentPath(): Promise<string | null> {
  try {
    const result = await runJxa(`
      const app = Application('Typora');
      if (!app.running()) { '' }
      else {
        const docs = app.documents();
        if (docs.length === 0) { '' }
        else { docs[0].path() }
      }
    `);
    return result || null;
  } catch {
    return null;
  }
}

export interface TyporaDocument {
  name: string;
  path: string;
}

export async function getDocuments(): Promise<TyporaDocument[]> {
  try {
    const result = await runJxa(`
      const app = Application('Typora');
      if (!app.running()) { JSON.stringify([]) }
      else {
        const docs = app.documents();
        JSON.stringify(docs.map(d => {
          let p = '';
          try { p = d.path(); } catch(e) {}
          return { name: d.name(), path: p };
        }));
      }
    `);
    return JSON.parse(result || "[]");
  } catch {
    return [];
  }
}

/**
 * Find the git root of a file path, or return the file's parent dir if not in a repo.
 * This matches what IDEs like VS Code use as their "workspace folder".
 */
export async function findWorkspaceRoot(filePath: string): Promise<string> {
  const dir = dirname(filePath);
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return dir;
  }
}

/** Open a file in Typora without blocking (fire-and-forget). */
export function openInTypora(filePath: string): void {
  const child = spawn("open", ["-a", "Typora", filePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
