import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from "./crypto.js";

const key = () => randomBytes(32);
const base64Key = (bytes = 32) => randomBytes(bytes).toString("base64");

describe("credential crypto (AES-256-GCM, account-bound)", () => {
  it("round-trips a secret under the same key and account", () => {
    const k = key();
    const envelope = encryptSecret("refresh-token-value", k, "me@example.com");
    expect(decryptSecret(envelope, k, "me@example.com")).toBe("refresh-token-value");
  });

  it("produces the v1 envelope prefix and never leaks the plaintext", () => {
    const envelope = encryptSecret("super-secret", key(), "me@example.com");
    expect(envelope.startsWith("v1:")).toBe(true);
    expect(envelope).not.toContain("super-secret");
  });

  it("uses a fresh IV so identical inputs produce different ciphertext", () => {
    const k = key();
    const a = encryptSecret("same", k, "me@example.com");
    const b = encryptSecret("same", k, "me@example.com");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt under a different key", () => {
    const envelope = encryptSecret("secret", key(), "me@example.com");
    expect(() => decryptSecret(envelope, key(), "me@example.com")).toThrow(CredentialCryptoError);
  });

  it("fails to decrypt when the account (AAD) does not match", () => {
    const k = key();
    const envelope = encryptSecret("secret", k, "me@example.com");
    expect(() => decryptSecret(envelope, k, "someone-else@example.com")).toThrow(
      CredentialCryptoError,
    );
  });

  it("fails to decrypt tampered ciphertext", () => {
    const k = key();
    const envelope = encryptSecret("secret", k, "me@example.com");
    const tampered = `${envelope.slice(0, -2)}${envelope.endsWith("A") ? "B" : "A"}=`;
    expect(() => decryptSecret(tampered, k, "me@example.com")).toThrow(CredentialCryptoError);
  });

  it("rejects an unrecognized envelope version", () => {
    expect(() => decryptSecret("v2:abcd", key(), "me@example.com")).toThrow(CredentialCryptoError);
  });

  it("validates key length", () => {
    expect(() => parseEncryptionKey(base64Key(16))).toThrow(CredentialCryptoError);
    expect(parseEncryptionKey(base64Key(32))).toHaveLength(32);
  });
});
