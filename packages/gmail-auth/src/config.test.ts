import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readGmailConfig } from "./config.js";

const validKey = randomBytes(32).toString("base64");

const liveEnv = {
  ORION_GMAIL_SOURCE: "live",
  GOOGLE_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/api/gmail/callback",
  ORION_GMAIL_ACCOUNT: "me@example.com",
  ORION_CREDENTIAL_ENCRYPTION_KEY: validKey,
};

describe("readGmailConfig (strict source selection)", () => {
  it("defaults to fixture mode", () => {
    expect(readGmailConfig({})).toEqual({ mode: "fixture" });
    expect(readGmailConfig({ ORION_GMAIL_SOURCE: "fixtures" })).toEqual({ mode: "fixture" });
  });

  it("resolves a fully configured live integration", () => {
    const config = readGmailConfig(liveEnv);
    expect(config.mode).toBe("live");
    if (config.mode === "live" && config.live) {
      expect(config.live.account).toBe("me@example.com");
      expect(config.live.credentialsDbPath).toMatch(/orion-credentials\.db$/);
    } else {
      throw new Error("expected a configured live integration");
    }
  });

  it("reports issues (never falls back to fixtures) when live vars are missing", () => {
    const config = readGmailConfig({ ORION_GMAIL_SOURCE: "live" });
    expect(config.mode).toBe("live");
    if (config.mode === "live" && config.live === null) {
      expect(config.issues.length).toBeGreaterThan(0);
      expect(config.issues.some((i) => i.includes("GOOGLE_OAUTH_CLIENT_ID"))).toBe(true);
    } else {
      throw new Error("expected a misconfigured live integration");
    }
  });

  it("flags an invalid encryption key", () => {
    const config = readGmailConfig({
      ...liveEnv,
      ORION_CREDENTIAL_ENCRYPTION_KEY: randomBytes(16).toString("base64"),
    });
    if (config.mode === "live" && config.live === null) {
      expect(config.issues.some((i) => i.includes("ORION_CREDENTIAL_ENCRYPTION_KEY"))).toBe(true);
    } else {
      throw new Error("expected a misconfigured live integration");
    }
  });

  it("honors an explicit credentials db path", () => {
    const config = readGmailConfig({ ...liveEnv, ORION_CREDENTIALS_DB_PATH: "/tmp/creds.db" });
    if (config.mode === "live" && config.live) {
      expect(config.live.credentialsDbPath).toBe("/tmp/creds.db");
    } else {
      throw new Error("expected a configured live integration");
    }
  });
});
