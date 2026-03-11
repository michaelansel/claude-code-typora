import { writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const IDE_DIR = join(homedir(), ".claude", "ide");

export interface LockFileContent {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: string;
  runningInWindows: boolean;
  authToken: string;
}

export async function writeLockFile(
  port: number,
  workspaceFolders: string[],
  authToken: string
): Promise<void> {
  await mkdir(IDE_DIR, { recursive: true });
  const content: LockFileContent = {
    pid: process.pid,
    workspaceFolders,
    ideName: "Typora",
    transport: "ws",
    runningInWindows: false,
    authToken,
  };
  const lockPath = join(IDE_DIR, `${port}.lock`);
  await writeFile(lockPath, JSON.stringify(content, null, 2), "utf-8");
}

export async function deleteLockFile(port: number): Promise<void> {
  const lockPath = join(IDE_DIR, `${port}.lock`);
  try {
    await unlink(lockPath);
  } catch {
    // Ignore if already deleted
  }
}

export function getLockFilePath(port: number): string {
  return join(IDE_DIR, `${port}.lock`);
}
