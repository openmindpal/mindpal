#!/usr/bin/env node
/**
 * boundary-scan.mjs — 架构边界扫描脚本
 *
 * 功能目标：
 *   扫描代码库中的 import 语句，检查是否违反 moduleBoundary.ts 中定义的边界规则。
 *   error 级违规将导致非零退出码，阻断 CI 合并/发布。
 *
 * 用法：
 *   node scripts/boundary-scan.mjs [--fix] [--verbose]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Boundary Rules (mirror of moduleBoundary.ts, kept in sync)
// ─────────────────────────────────────────────────────────────────────────────
const MODULE_BOUNDARY_RULES = [
  {
    name: "kernel-no-import-skills",
    source: "apps/api/src/kernel/**",
    forbidden: ["/skills/", "../skills/"],
    // 注：modules/skills/ 是合法的 modules 子目录，不是顶层 skills/ 目录
    exceptions: ["modules/skills/"],
    severity: "error",
  },
  {
    name: "kernel-no-import-routes",
    source: "apps/api/src/kernel/**",
    forbidden: ["routes/", "/routes/"],
    severity: "error",
  },
  {
    name: "kernel-no-import-modules-skills",
    source: "apps/api/src/kernel/**",
    forbidden: ["modules/skills/"],
    // TECH-DEBT: planningKernel.ts 依赖 modules/skills/skillRouter 的 routeByIntent
    // 应将 skillRouter 重命名或迁移以清晰表达职责。跟踪 issue: TODO
    exceptions: ["modules/skills/skillRouter"],
    severity: "error",
  },
  {
    name: "shared-no-import-apps",
    source: "packages/shared/src/**",
    forbidden: ["apps/", "/apps/"],
    severity: "error",
  },
  {
    name: "skills-no-cross-import",
    source: "apps/api/src/skills/*/modules/**",
    forbidden: ["../../*/modules/"],
    exceptions: ["../modules/"],
    severity: "warn",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Glob Matching
// ─────────────────────────────────────────────────────────────────────────────
function matchGlob(filePath, pattern) {
  const normalized = filePath.replace(/\\/g, "/");
  const regex = pattern
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(normalized);
}

function matchImportPattern(importPath, pattern) {
  const normalizedImport = importPath.replace(/\\/g, "/");
  // Check if import path contains the forbidden pattern
  const patternParts = pattern.replace(/\.\.\//g, "").replace(/\*\*/g, "").replace(/\*/g, "");
  if (patternParts && normalizedImport.includes(patternParts)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract Imports from File
// ─────────────────────────────────────────────────────────────────────────────
function extractImports(content) {
  const imports = [];
  // Match: import ... from "..."  or  import ... from '...'
  const importRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  // Match: require("...") or require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check Single File
// ─────────────────────────────────────────────────────────────────────────────
function checkFile(filePath, content) {
  const violations = [];
  const relPath = path.relative(ROOT, filePath).replace(/\\/g, "/");
  const imports = extractImports(content);

  for (const rule of MODULE_BOUNDARY_RULES) {
    if (!matchGlob(relPath, rule.source)) continue;

    for (const imp of imports) {
      // Skip node_modules / external packages
      if (!imp.startsWith(".") && !imp.startsWith("/")) continue;

      const isForbidden = rule.forbidden.some((pattern) => matchImportPattern(imp, pattern));
      const isException = rule.exceptions?.some((pattern) => matchImportPattern(imp, pattern)) ?? false;

      if (isForbidden && !isException) {
        violations.push({
          rule: rule.name,
          file: relPath,
          importPath: imp,
          severity: rule.severity,
        });
      }
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursively Scan Directory
// ─────────────────────────────────────────────────────────────────────────────
function scanDirectory(dir, extensions = [".ts", ".tsx", ".js", ".mjs"]) {
  const allViolations = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      // Skip node_modules, dist, .git
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git", "coverage", ".next"].includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.includes(ext)) continue;

        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const violations = checkFile(fullPath, content);
          allViolations.push(...violations);
        } catch (err) {
          console.error(`[boundary-scan] Failed to read ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  walk(dir);
  return allViolations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");

  console.log("[boundary-scan] Scanning architecture boundary violations...\n");

  // Scan relevant directories
  const dirsToScan = [
    path.join(ROOT, "apps"),
    path.join(ROOT, "packages"),
  ];

  let allViolations = [];
  for (const dir of dirsToScan) {
    if (fs.existsSync(dir)) {
      const violations = scanDirectory(dir);
      allViolations.push(...violations);
    }
  }

  // Categorize violations
  const errors = allViolations.filter((v) => v.severity === "error");
  const warnings = allViolations.filter((v) => v.severity === "warn");

  // Report
  if (verbose || allViolations.length > 0) {
    for (const v of allViolations) {
      const icon = v.severity === "error" ? "❌" : "⚠️";
      console.log(`${icon} [${v.severity.toUpperCase()}] ${v.rule}`);
      console.log(`   File: ${v.file}`);
      console.log(`   Import: ${v.importPath}\n`);
    }
  }

  // Summary
  console.log("─".repeat(60));
  console.log(`[boundary-scan] Summary:`);
  console.log(`   Files scanned: (all .ts/.tsx/.js/.mjs in apps/ & packages/)`);
  console.log(`   Errors: ${errors.length}`);
  console.log(`   Warnings: ${warnings.length}`);
  console.log("─".repeat(60));

  if (errors.length > 0) {
    console.log("\n❌ Architecture boundary violations found! CI will fail.\n");
    console.log("To fix: Review the import statements listed above and ensure they");
    console.log("comply with the boundary rules defined in moduleBoundary.ts.\n");
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log("\n⚠️  Warnings found. Consider reviewing cross-skill imports.\n");
  } else {
    console.log("\n✅ No boundary violations found.\n");
  }

  process.exit(0);
}

main();
