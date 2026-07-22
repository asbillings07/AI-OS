import Database from "better-sqlite3";
import type { CredentialStore, CredentialStatus, StoredCredential } from "./credential-store.js";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./crypto.js";

/**
 * The private, on-disk row. This is the ONLY type that holds ciphertext; it
 * never escapes this module. Credentials are deliberately kept OUT of the event
 * log (ADR-0009) — they are not facts about the world, and the log is replayable
 * and inspectable in ways a secret must not be.
 */
interface CredentialRow {
  account: string;
  refresh_token_envelope: string;
  status: string;
  updated_at: string;
}

/**
 * Single-account credential store backed by its own SQLite file, encrypting the
 * refresh token with AES-256-GCM (account bound as AAD). Access tokens are never
 * stored. Decryption failures surface as `CredentialCryptoError` (misconfig),
 * distinct from a Google revocation.
 */
export class SqliteCredentialStore implements CredentialStore {
  readonly #db: Database.Database;
  readonly #key: Buffer;
  readonly #select: Database.Statement;
  readonly #upsert: Database.Statement;
  readonly #updateToken: Database.Statement;
  readonly #delete: Database.Statement;

  constructor(location: string, encryptionKeyBase64: string) {
    // Validate the key up front so a bad key fails loudly at construction.
    this.#key = parseEncryptionKey(encryptionKeyBase64);
    this.#db = new Database(location);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_credential (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        account                TEXT NOT NULL,
        refresh_token_envelope TEXT NOT NULL,
        status                 TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
    `);
    this.#select = this.#db.prepare(
      `SELECT account, refresh_token_envelope, status, updated_at FROM gmail_credential WHERE id = 1`,
    );
    this.#upsert = this.#db.prepare(`
      INSERT INTO gmail_credential (id, account, refresh_token_envelope, status, updated_at)
      VALUES (1, @account, @envelope, @status, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        account = @account,
        refresh_token_envelope = @envelope,
        status = @status,
        updated_at = @updatedAt
    `);
    this.#updateToken = this.#db.prepare(
      `UPDATE gmail_credential SET refresh_token_envelope = @envelope, updated_at = @updatedAt WHERE id = 1`,
    );
    this.#delete = this.#db.prepare(`DELETE FROM gmail_credential WHERE id = 1`);
  }

  async read(): Promise<StoredCredential | null> {
    const row = this.#select.get() as CredentialRow | undefined;
    if (!row) return null;
    const refreshToken = decryptSecret(row.refresh_token_envelope, this.#key, row.account);
    return {
      account: row.account,
      refreshToken,
      status: row.status as CredentialStatus,
      updatedAt: row.updated_at,
    };
  }

  async write(value: StoredCredential): Promise<void> {
    const envelope = encryptSecret(value.refreshToken, this.#key, value.account);
    this.#upsert.run({
      account: value.account,
      envelope,
      status: value.status,
      updatedAt: value.updatedAt,
    });
  }

  async updateRefreshToken(refreshToken: string, updatedAt: string): Promise<void> {
    // Read the account (needed as encryption AAD), re-encrypt, and update only
    // the token + timestamp. This runs as synchronous better-sqlite3 calls with
    // no await in between, so status is preserved atomically within the process.
    const row = this.#select.get() as CredentialRow | undefined;
    if (!row) return;
    const envelope = encryptSecret(refreshToken, this.#key, row.account);
    this.#updateToken.run({ envelope, updatedAt });
  }

  async delete(): Promise<void> {
    this.#delete.run();
  }

  close(): void {
    this.#db.close();
  }
}
