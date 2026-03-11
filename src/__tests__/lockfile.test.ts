import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// We patch the lockfile module to use a temp dir instead of ~/.claude/ide/
// by re-implementing the logic inline for testing

const IDE_DIR_DEFAULT = join(homedir(), ".claude", "ide");

async function writeLockFileToDir(
  dir: string,
  port: number,
  workspaceFolders: string[],
  authToken: string
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const content = {
    pid: process.pid,
    workspaceFolders,
    ideName: "Typora",
    transport: "ws",
    runningInWindows: false,
    authToken,
  };
  await writeFile(join(dir, `${port}.lock`), JSON.stringify(content, null, 2));
}

describe("lockfile", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "typora-bridge-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates lock file at correct path", async () => {
    await writeLockFileToDir(tmpDir, 9999, ["/test/workspace"], "token-abc");
    const lockPath = join(tmpDir, "9999.lock");
    await access(lockPath); // throws if doesn't exist
  });

  it("lock file has correct JSON shape", async () => {
    const port = 8888;
    const workspaceFolders = ["/some/path", "/another/path"];
    const authToken = "uuid-test-token";

    await writeLockFileToDir(tmpDir, port, workspaceFolders, authToken);
    const content = JSON.parse(
      await readFile(join(tmpDir, `${port}.lock`), "utf-8")
    );

    assert.equal(typeof content.pid, "number");
    assert.equal(content.pid, process.pid);
    assert.deepEqual(content.workspaceFolders, workspaceFolders);
    assert.equal(content.ideName, "Typora");
    assert.equal(content.transport, "ws");
    assert.equal(content.runningInWindows, false);
    assert.equal(content.authToken, authToken);
  });

  it("delete removes the lock file", async () => {
    const port = 7777;
    await writeLockFileToDir(tmpDir, port, [], "token-del");
    const lockPath = join(tmpDir, `${port}.lock`);

    // Verify it exists
    await access(lockPath);

    // Delete it
    const { unlink } = await import("node:fs/promises");
    await unlink(lockPath);

    // Verify it's gone
    let errored = false;
    try {
      await access(lockPath);
    } catch {
      errored = true;
    }
    assert.ok(errored, "Lock file should have been deleted");
  });

  it("writeLockFile from module creates correct file in ~/.claude/ide/", async () => {
    // Use the real module but clean up after
    const { writeLockFile, deleteLockFile, getLockFilePath } = await import("../lockfile.js");
    const port = 65432;
    const authToken = "module-test-token";

    await writeLockFile(port, ["/test"], authToken);

    const lockPath = getLockFilePath(port);
    const content = JSON.parse(await readFile(lockPath, "utf-8"));

    assert.equal(content.ideName, "Typora");
    assert.equal(content.authToken, authToken);
    assert.deepEqual(content.workspaceFolders, ["/test"]);

    await deleteLockFile(port);

    // Verify deleted
    let errored = false;
    try {
      await access(lockPath);
    } catch {
      errored = true;
    }
    assert.ok(errored, "Lock file should have been deleted by deleteLockFile");
  });
});
