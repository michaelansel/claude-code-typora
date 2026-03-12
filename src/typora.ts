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

export async function isTyporaRunning(): Promise<boolean> {
  try {
    const result = await runJxa(`
      const app = Application('Typora');
      app.running();
    `);
    return result === "true";
  } catch {
    return false;
  }
}

export async function isTyporaFrontmost(): Promise<boolean> {
  try {
    const result = await runJxa(`
      Application('System Events').frontmost.frontmostApplication.name() === 'Typora'
    `);
    return result === "true";
  } catch {
    return false;
  }
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

/** Write text to the clipboard using pbcopy (handles arbitrary content). */
function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
    proc.stdin.end(text, "utf-8");
  });
}

export async function getSelection(): Promise<{ text: string; filePath: string | null }> {
  // Save current clipboard contents so we can restore after Cmd+C
  let savedClipboard = "";
  try {
    const { stdout } = await execFileAsync("pbpaste");
    savedClipboard = stdout;
  } catch {
    // Ignore
  }

  try {
    // Clear clipboard so we can detect whether Cmd+C actually copied anything
    await pbcopy("");

    // Bring Typora to front
    await runJxa(`
      const app = Application('Typora');
      if (app.running()) { app.activate(); }
    `);

    // Small delay for focus to settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simulate Cmd+C via System Events
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to keystroke "c" using command down',
    ]);

    // Small delay for clipboard to update
    await new Promise((resolve) => setTimeout(resolve, 150));

    const { stdout: copiedText } = await execFileAsync("pbpaste");
    const filePath = await getFrontDocumentPath();

    return { text: copiedText, filePath };
  } finally {
    // Restore clipboard using pbcopy (handles arbitrary text correctly)
    try {
      await pbcopy(savedClipboard);
    } catch {
      // Best-effort
    }
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

/**
 * Get the selected text from Typora without bringing it to the foreground.
 * Uses a targeted System Events keystroke so the user's active app stays focused.
 * Saves and restores the clipboard around the operation.
 * Returns empty string if nothing is selected or Typora is not running.
 */
export async function getSelectionText(): Promise<string> {
  let savedClipboard = "";
  try {
    const { stdout } = await execFileAsync("pbpaste");
    savedClipboard = stdout;
  } catch { /* ignore */ }

  try {
    await pbcopy("");

    // Send Cmd+C directly to the Typora process without activating it.
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to tell process "Typora" to keystroke "c" using command down',
    ]);

    await new Promise((r) => setTimeout(r, 150));

    const { stdout: text } = await execFileAsync("pbpaste");
    return text;
  } catch {
    return "";
  } finally {
    await pbcopy(savedClipboard).catch(() => {});
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
