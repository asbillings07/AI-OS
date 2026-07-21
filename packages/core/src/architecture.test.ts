import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture fitness tests: the boundary rules from ADR-0007/0008/0010 and
 * Eng #8, enforced as code. A violation fails here — cheap now, an expensive
 * rescue later. We read source from disk (not the module graph) so a forbidden
 * import fails even if it type-checks.
 *
 * packages/core/src/architecture.test.ts -> up 3 dirs is the repo root.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".data",
  ".git",
  "out",
]);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      entry.name !== "next-env.d.ts"
    ) {
      files.push(full);
    }
  }
  return files;
}

/** Every module specifier imported/exported/dynamically-imported in a file. */
function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^;{]*?\bfrom\s*["']([^"']+)["']/g, // import x from "y" / export … from "y"
    /\bimport\s*["']([^"']+)["']/g, // bare: import "y"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic: import("y")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("y")
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

/** A spec violates a rule if it equals the forbidden id or is a subpath of it. */
function matches(spec: string, forbidden: string): boolean {
  return spec === forbidden || spec.startsWith(`${forbidden}/`);
}

function violations(dir: string, forbidden: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of collectSourceFiles(dir)) {
    const specs = importSpecifiers(readFileSync(file, "utf8"));
    for (const spec of specs) {
      const hit = forbidden.find((f) => matches(spec, f));
      if (hit) {
        found.push(`${path.relative(repoRoot, file)} imports "${spec}" (forbidden: ${hit})`);
      }
    }
  }
  return found;
}

const UI = ["next", "react", "react-dom"] as const;
const PROVIDER_SDKS = ["openai", "@anthropic-ai/sdk", "@google/generative-ai", "@aws-sdk"] as const;

describe("architecture fitness", () => {
  it("core is domain-only: no skills, no AI, no UI, no provider SDKs", () => {
    const dir = path.join(repoRoot, "packages", "core", "src");
    // core MAY use better-sqlite3 (the storage impl behind EventStore, ADR-0009).
    const forbidden = [
      "@orion/ai",
      "@orion/gmail-skill",
      "@orion/fixtures",
      "@orion/mission-control",
      ...UI,
      ...PROVIDER_SDKS,
    ];
    expect(violations(dir, forbidden)).toEqual([]);
  });

  it("the AI package never leaks into core, skills, or the UI", () => {
    // AI is a self-contained capability layer (ADR-0011): it depends on nothing
    // else in the workspace, so providers can't reach the domain.
    const dir = path.join(repoRoot, "packages", "ai", "src");
    const forbidden = [
      "@orion/core",
      "@orion/gmail-skill",
      "@orion/fixtures",
      "@orion/mission-control",
      ...UI,
    ];
    expect(violations(dir, forbidden)).toEqual([]);
  });

  it("the Gmail skill talks to Orion only through core (and fixtures)", () => {
    // A Skill extends Orion via events/interfaces (ADR-0010); it must not reach
    // into the AI layer or the UI, nor call a provider SDK directly.
    const dir = path.join(repoRoot, "packages", "gmail-skill", "src");
    const forbidden = ["@orion/ai", "@orion/mission-control", ...UI, ...PROVIDER_SDKS];
    expect(violations(dir, forbidden)).toEqual([]);
  });

  it("fixtures are inert data: they import nothing from the workspace", () => {
    const dir = path.join(repoRoot, "packages", "fixtures", "src");
    const forbidden = [
      "@orion/core",
      "@orion/ai",
      "@orion/gmail-skill",
      "@orion/mission-control",
      ...UI,
    ];
    expect(violations(dir, forbidden)).toEqual([]);
  });

  it("dependencies point inward: no package depends on the Mission Control app", () => {
    const packagesDir = path.join(repoRoot, "packages");
    const forbidden = ["@orion/mission-control"];
    const found: string[] = [];
    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      found.push(...violations(path.join(packagesDir, pkg.name), forbidden));
    }
    expect(found).toEqual([]);
  });
});
