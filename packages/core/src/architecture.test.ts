import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture fitness tests: the boundary rules from ADR-0007/0008/0010 and
 * Eng #8, enforced as code. A violation fails here — cheap now, an expensive
 * rescue later.
 *
 * Two design choices make these guardrails trustworthy rather than decorative:
 *  1. We parse imports with the TypeScript compiler (not regex), so every syntax
 *     form is covered: default, named, namespace, type-only, re-exports, bare,
 *     dynamic import, and require.
 *  2. We enforce where a dependency *points*, not how it's spelled. A relative
 *     import that crosses into another package (`../../ai/src/...`) is resolved
 *     to its target package and checked the same as an `@orion/ai` alias.
 *
 * packages/core/src/architecture.test.ts -> up 3 dirs is the repo root.
 */
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const IGNORED_DIRS = new Set(["node_modules", "dist", ".next", ".data", ".git", "out"]);

/** Workspace package roots (repo-relative, POSIX) -> package name. */
const WORKSPACE_PACKAGES: ReadonlyArray<{ dir: string; name: string }> = [
  { dir: "packages/core", name: "@orion/core" },
  { dir: "packages/ai", name: "@orion/ai" },
  { dir: "packages/gmail-skill", name: "@orion/gmail-skill" },
  { dir: "packages/github-skill", name: "@orion/github-skill" },
  { dir: "packages/fixtures", name: "@orion/fixtures" },
  { dir: "apps/mission-control", name: "@orion/mission-control" },
];

const UI = ["next", "react", "react-dom"] as const;
const PROVIDER_SDKS = ["openai", "@anthropic-ai/sdk", "@google/generative-ai", "@aws-sdk"] as const;

interface PackageRule {
  name: string;
  dir: string;
  /** Other workspace packages this package may depend on. */
  allowedWorkspace: readonly string[];
  /** External (npm) specifiers this package may NOT import. */
  forbiddenExternal: readonly string[];
}

const RULES: readonly PackageRule[] = [
  {
    // core is domain-only. It MAY use better-sqlite3 (the storage impl behind
    // EventStore, ADR-0009), but nothing else in the workspace, no UI, no SDKs.
    name: "@orion/core",
    dir: "packages/core",
    allowedWorkspace: [],
    forbiddenExternal: [...UI, ...PROVIDER_SDKS],
  },
  {
    // The AI layer is self-contained (ADR-0011): no workspace deps at all, so a
    // provider can never reach the domain. It may use provider SDKs itself.
    name: "@orion/ai",
    dir: "packages/ai",
    allowedWorkspace: [],
    forbiddenExternal: [...UI, "better-sqlite3"],
  },
  {
    // A Skill extends Orion through core's interfaces/events (ADR-0010); it uses
    // fixtures for offline data. No AI layer, no UI, no direct provider calls,
    // and — critically — no other Skill (Gmail must not know GitHub exists).
    name: "@orion/gmail-skill",
    dir: "packages/gmail-skill",
    allowedWorkspace: ["@orion/core", "@orion/fixtures"],
    forbiddenExternal: [...UI, ...PROVIDER_SDKS],
  },
  {
    // The second Skill mirrors the first: core + fixtures only. It must not reach
    // into the Gmail Skill, the AI layer, UI, or provider SDKs.
    name: "@orion/github-skill",
    dir: "packages/github-skill",
    allowedWorkspace: ["@orion/core", "@orion/fixtures"],
    forbiddenExternal: [...UI, ...PROVIDER_SDKS],
  },
  {
    // Fixtures are inert data: they import nothing from the workspace.
    name: "@orion/fixtures",
    dir: "packages/fixtures",
    allowedWorkspace: [],
    forbiddenExternal: [...UI, ...PROVIDER_SDKS, "better-sqlite3"],
  },
  {
    // The app depends inward on any @orion package and may use its own UI stack.
    name: "@orion/mission-control",
    dir: "apps/mission-control",
    allowedWorkspace: [
      "@orion/core",
      "@orion/ai",
      "@orion/gmail-skill",
      "@orion/github-skill",
      "@orion/fixtures",
    ],
    forbiddenExternal: [],
  },
];

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

/**
 * Every module specifier imported/exported/dynamically-required in a file, via
 * the TypeScript parser. Covers import/export declarations (incl. type-only and
 * re-exports), bare imports, `import x = require()`, dynamic `import()`, and
 * `require()`.
 */
function moduleSpecifiers(filePath: string, content: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs: string[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const [arg] = node.arguments;
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteral(arg)) {
        specs.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** Which workspace package owns an absolute path, if any. */
function packageOwning(absPath: string): string | undefined {
  const rel = toPosix(path.relative(repoRoot, absPath));
  return WORKSPACE_PACKAGES.find((p) => rel === p.dir || rel.startsWith(`${p.dir}/`))?.name;
}

/**
 * The workspace package a specifier points at, or undefined if it's external or
 * a node builtin. `@orion/x/sub` normalizes to `@orion/x`; relative specifiers
 * are resolved from the importing file so cross-package escapes are caught.
 */
function targetWorkspacePackage(spec: string, importingFile: string): string | undefined {
  if (spec.startsWith("@orion/")) {
    const [scope, name] = spec.split("/");
    return `${scope}/${name}`;
  }
  if (spec.startsWith(".")) {
    return packageOwning(path.resolve(path.dirname(importingFile), spec));
  }
  return undefined;
}

function isBareExternal(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("@orion/");
}

/** Boundary violations for a single file's contents under a rule. */
function violationsInContent(rule: PackageRule, absFilePath: string, content: string): string[] {
  const rel = toPosix(path.relative(repoRoot, absFilePath));
  const found: string[] = [];
  for (const spec of moduleSpecifiers(absFilePath, content)) {
    const target = targetWorkspacePackage(spec, absFilePath);
    if (target !== undefined) {
      if (target !== rule.name && !rule.allowedWorkspace.includes(target)) {
        found.push(`${rel} imports "${spec}" -> ${target} (not a permitted dependency of ${rule.name})`);
      }
    } else if (isBareExternal(spec)) {
      const hit = rule.forbiddenExternal.find((f) => spec === f || spec.startsWith(`${f}/`));
      if (hit) found.push(`${rel} imports "${spec}" (forbidden external: ${hit})`);
    }
  }
  return found;
}

function scanPackage(rule: PackageRule): string[] {
  const found: string[] = [];
  for (const file of collectSourceFiles(path.join(repoRoot, rule.dir))) {
    found.push(...violationsInContent(rule, file, readFileSync(file, "utf8")));
  }
  return found;
}

describe("architecture fitness — source imports", () => {
  for (const rule of RULES) {
    it(`${rule.name} imports only within its allowed boundaries`, () => {
      expect(scanPackage(rule)).toEqual([]);
    });
  }
});

describe("architecture fitness — package manifests", () => {
  it("manifests declare only permitted workspace dependencies", () => {
    const violations: string[] = [];
    for (const rule of RULES) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, rule.dir, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
      for (const dep of Object.keys(deps)) {
        if (dep.startsWith("@orion/") && dep !== rule.name && !rule.allowedWorkspace.includes(dep)) {
          violations.push(`${rule.name} package.json declares forbidden workspace dep ${dep}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * The guardrails must be *seen to fail*. These feed deliberately-violating
 * content to the same checker the real scan uses. A fitness test that has never
 * failed is a decorative smoke alarm.
 */
describe("architecture fitness — the checker actually catches violations", () => {
  const coreRule = RULES.find((r) => r.name === "@orion/core")!;
  const coreFile = path.join(repoRoot, "packages", "core", "src", "__probe__.ts");

  it("extracts the specifier from every import/export syntax", () => {
    const forms: ReadonlyArray<[string, string]> = [
      ["default", 'import x from "@orion/ai";'],
      ["named", 'import { x } from "@orion/ai";'],
      ["namespace", 'import * as x from "@orion/ai";'],
      ["type-only", 'import type { X } from "@orion/ai";'],
      ["named re-export", 'export { x } from "@orion/ai";'],
      ["star re-export", 'export * from "@orion/ai";'],
      ["bare", 'import "@orion/ai";'],
      ["dynamic", 'const p = import("@orion/ai");'],
      ["require", 'const y = require("@orion/ai");'],
      ["import-equals", 'import z = require("@orion/ai");'],
    ];
    for (const [label, code] of forms) {
      expect(moduleSpecifiers("f.ts", code), label).toContain("@orion/ai");
    }
  });

  it("catches a named import of a forbidden package (the regex-era blind spot)", () => {
    expect(violationsInContent(coreRule, coreFile, 'import { createAi } from "@orion/ai";')).not.toEqual([]);
  });

  it("catches a relative import that escapes into another package", () => {
    expect(
      violationsInContent(coreRule, coreFile, 'import { createAi } from "../../ai/src/index.js";'),
    ).not.toEqual([]);
  });

  it("catches a forbidden external (UI) import", () => {
    expect(violationsInContent(coreRule, coreFile, 'import { useState } from "react";')).not.toEqual([]);
  });

  it("catches one Skill importing another (Gmail must not know GitHub exists)", () => {
    const githubRule = RULES.find((r) => r.name === "@orion/github-skill")!;
    const githubFile = path.join(repoRoot, "packages", "github-skill", "src", "__probe__.ts");
    expect(
      violationsInContent(githubRule, githubFile, 'import { GmailSkill } from "@orion/gmail-skill";'),
    ).not.toEqual([]);
  });

  it("allows the storage impl, node builtins, and same-package relatives in core", () => {
    expect(violationsInContent(coreRule, coreFile, 'import Database from "better-sqlite3";')).toEqual([]);
    expect(violationsInContent(coreRule, coreFile, 'import { readFileSync } from "node:fs";')).toEqual([]);
    expect(violationsInContent(coreRule, coreFile, 'import { x } from "./events/index.js";')).toEqual([]);
  });
});
