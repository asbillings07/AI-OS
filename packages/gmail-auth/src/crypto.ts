import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for the one secret we persist: the Gmail
 * refresh token. Encryption is an implementation detail of the SQLite credential
 * store — nothing above the store sees ciphertext.
 *
 * Envelope format: `v1:<base64(iv(12) || authTag(16) || ciphertext)>`. The
 * version prefix lets the scheme evolve without silently misreading old rows.
 * The account id is bound in as GCM Additional Authenticated Data, so a row
 * cannot be decrypted under a different account even with the right key.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Bad key or unreadable envelope: a *configuration* problem, not a revocation. */
export class CredentialCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialCryptoError";
  }
}

/** Parse and validate the canonical 32-byte base64 key. */
export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `ORION_CREDENTIAL_ENCRYPTION_KEY must be ${KEY_BYTES} bytes encoded as base64 (got ${key.length} bytes).`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, authTag, ciphertext]).toString("base64")}`;
}

export function decryptSecret(envelope: string, key: Buffer, aad: string): string {
  const separator = envelope.indexOf(":");
  const version = separator === -1 ? "" : envelope.slice(0, separator);
  const payload = separator === -1 ? "" : envelope.slice(separator + 1);
  if (version !== VERSION || payload === "") {
    throw new CredentialCryptoError("Unrecognized credential envelope.");
  }

  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new CredentialCryptoError("Credential envelope is truncated.");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    // Wrong key, tampered ciphertext, or an account/AAD mismatch: all misconfig.
    throw new CredentialCryptoError(
      "Failed to decrypt the stored Gmail credential (wrong encryption key or tampered data).",
      { cause: error },
    );
  }
}
