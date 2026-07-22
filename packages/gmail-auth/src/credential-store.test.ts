import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
import { SqliteCredentialStore } from "./sqlite-credential-store.js";
import { InMemoryCredentialStore } from "./in-memory-credential-store.js";
import { CredentialCryptoError } from "./crypto.js";
import type { StoredCredential } from "./credential-store.js";

const KEY = randomBytes(32).toString("base64");

const credential: StoredCredential = {
  account: "me@example.com",
  refreshToken: "1//refresh-token-value",
  status: "active",
  updatedAt: "2026-07-21T10:00:00.000Z",
};

const stores: SqliteCredentialStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function newSqliteStore(key = KEY): { store: SqliteCredentialStore; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "orion-cred-"));
  const file = path.join(dir, "credentials.db");
  const store = new SqliteCredentialStore(file, key);
  stores.push(store);
  return { store, file };
}

describe("SqliteCredentialStore (encrypted at rest)", () => {
  it("round-trips a credential", async () => {
    const { store } = newSqliteStore();
    await store.write(credential);
    expect(await store.read()).toEqual(credential);
  });

  it("never stores the refresh token as plaintext on disk", async () => {
    const { store, file } = newSqliteStore();
    await store.write(credential);
    const bytes = readFileSync(file);
    expect(bytes.includes(Buffer.from(credential.refreshToken))).toBe(false);
  });

  it("persists reconnect_required durably", async () => {
    const { store } = newSqliteStore();
    await store.write({ ...credential, status: "reconnect_required" });
    expect((await store.read())?.status).toBe("reconnect_required");
  });

  it("upserts (single account row) and deletes", async () => {
    const { store } = newSqliteStore();
    await store.write(credential);
    await store.write({ ...credential, refreshToken: "1//rotated" });
    expect((await store.read())?.refreshToken).toBe("1//rotated");
    await store.delete();
    expect(await store.read()).toBeNull();
  });

  it("cannot decrypt a row written under a different key", async () => {
    const { store, file } = newSqliteStore();
    await store.write(credential);
    store.close();
    stores.pop();
    const wrongKey = new SqliteCredentialStore(file, randomBytes(32).toString("base64"));
    stores.push(wrongKey);
    await expect(wrongKey.read()).rejects.toThrow(CredentialCryptoError);
  });

  it("returns null when empty", async () => {
    const { store } = newSqliteStore();
    expect(await store.read()).toBeNull();
  });
});

describe("InMemoryCredentialStore", () => {
  it("round-trips and copies (no aliasing)", async () => {
    const store = new InMemoryCredentialStore();
    await store.write(credential);
    const read = await store.read();
    expect(read).toEqual(credential);
    expect(read).not.toBe(credential);
  });

  it("deletes", async () => {
    const store = new InMemoryCredentialStore(credential);
    expect(await store.read()).toEqual(credential);
    await store.delete();
    expect(await store.read()).toBeNull();
  });
});
