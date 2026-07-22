/**
 * The persisted authorization for the single dogfood Gmail account.
 *
 * This is the *logical* value. Encryption is entirely a concern of the SQLite
 * implementation; callers (the authorization service) never see ciphertext.
 * Only the refresh token and account metadata are persisted — access tokens are
 * short-lived and kept in memory by google-auth-library.
 */
export type CredentialStatus = "active" | "reconnect_required";

export interface StoredCredential {
  readonly account: string;
  readonly refreshToken: string;
  /** `reconnect_required` is durable: a revoked token must stay unusable across restarts. */
  readonly status: CredentialStatus;
  readonly updatedAt: string;
}

/** A single-account credential store. `read`/`write`/`delete`, no ciphertext in the interface. */
export interface CredentialStore {
  read(): Promise<StoredCredential | null>;
  write(value: StoredCredential): Promise<void>;
  /**
   * Rotate the refresh token WITHOUT touching status. This is a distinct,
   * status-preserving operation on purpose: a read-modify-write that carried
   * `status: "active"` could race with a concurrent flip to `reconnect_required`
   * and silently revive a dead credential. Implementations must update only the
   * token and timestamp, atomically. A no-op if no credential is stored.
   */
  updateRefreshToken(refreshToken: string, updatedAt: string): Promise<void>;
  delete(): Promise<void>;
}
