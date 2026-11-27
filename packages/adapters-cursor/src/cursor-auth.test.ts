import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readCursorAuthCredentials } from "./cursor-auth.js";

describe("readCursorAuthCredentials", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads cursor auth keys from globalStorage state.vscdb", async () => {
    const root = join(process.cwd(), `.tmp-cursor-auth-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const dbPath = join(root, "state.vscdb");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      '"jwt-token-value"'
    );
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/cachedEmail",
      '"dev@example.com"'
    );
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/stripeMembershipType",
      '"pro"'
    );
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "storage.serviceMachineId",
      '"machine-123"'
    );
    db.close();

    expect(readCursorAuthCredentials(dbPath)).toEqual({
      accessToken: "jwt-token-value",
      refreshToken: null,
      email: "dev@example.com",
      planTier: "pro",
      subscriptionStatus: null,
      machineId: "machine-123"
    });
  });

  it("returns null when access token is missing", async () => {
    const root = join(process.cwd(), `.tmp-cursor-auth-empty-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const dbPath = join(root, "state.vscdb");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    db.close();

    expect(readCursorAuthCredentials(dbPath)).toBeNull();
  });

  it("uses an existing CLI session only when it matches the encrypted IDE account", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-auth-"));
    roots.push(root);
    const dbPath = join(root, "state.vscdb");
    const authPath = join(root, "auth.json");
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
      const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
      insert.run("cursorAuth/accessToken", "cursor-safe-storage:v1:encrypted-access");
      insert.run("cursorAuth/refreshToken", "cursor-safe-storage:v1:encrypted-refresh");
      insert.run("cursorAuth/cachedScopedProfile", JSON.stringify({ authId: "account-1" }));
      insert.run("cursorAuth/cachedEmail", "dev@example.com");
    } finally {
      db.close();
    }

    expect(readCursorAuthCredentials(dbPath, authPath)).toBeNull();

    const createToken = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;
    await writeFile(authPath, JSON.stringify({ accessToken: createToken("account-2") }));
    expect(readCursorAuthCredentials(dbPath, authPath)).toBeNull();

    const accessToken = createToken("account-1");
    await writeFile(authPath, JSON.stringify({ accessToken, refreshToken: "cli-refresh-token" }));
    expect(readCursorAuthCredentials(dbPath, authPath)).toMatchObject({
      accessToken,
      refreshToken: null,
      email: "dev@example.com"
    });
  });
});
