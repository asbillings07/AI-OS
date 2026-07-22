import type { CredentialStore, StoredCredential } from "./credential-store.js";

/**
 * A store that keeps the logical value directly — no encryption, no disk. For
 * tests and any ephemeral use. Copies on the way in and out so callers cannot
 * mutate the held value by reference.
 */
export class InMemoryCredentialStore implements CredentialStore {
  #value: StoredCredential | null;

  constructor(initial: StoredCredential | null = null) {
    this.#value = initial ? { ...initial } : null;
  }

  async read(): Promise<StoredCredential | null> {
    return this.#value ? { ...this.#value } : null;
  }

  async write(value: StoredCredential): Promise<void> {
    this.#value = { ...value };
  }

  async delete(): Promise<void> {
    this.#value = null;
  }
}
