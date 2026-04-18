#!/usr/bin/env node

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Sample = {
  command: string;
  iteration: number;
  durationMs: number;
  ok: boolean;
  outputTail: string;
};

type BenchmarkReport = {
  timestamp: string;
  cwd: string;
  iterations: number;
  measurementType: "measured-command-benchmark";
  commands: string[];
  samples: Sample[];
  summary: Array<{
    command: string;
    runs: number;
    okRuns: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
  }>;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const commands: string[] = [];
  let iterations = 1;
  let output = "tmp-benchmark-report.json";
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--command" && args[i + 1]) commands.push(args[++i]);
    else if (args[i] === "--iterations" && args[i + 1]) iterations = Math.max(1, Number(args[++i]) || 1);
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
    else if (args[i] === "--cwd" && args[i + 1]) cwd = resolve(args[++i]);
  }
  return { commands, iterations, output, cwd };
}

function trimOutput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? normalized.slice(-240) : normalized;
}

function runMeasuredCommand(command: string, iteration: number, cwd: string): Sample {
  const startedAt = process.hrtime.bigint();
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    const endedAt = process.hrtime.bigint();
    return {
      command,
      iteration,
      durationMs: Number(endedAt - startedAt) / 1_000_000,
      ok: true,
      outputTail: trimOutput(output),
    };
  } catch (error: any) {
    const endedAt = process.hrtime.bigint();
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return {
      command,
      iteration,
      durationMs: Number(endedAt - startedAt) / 1_000_000,
      ok: false,
      outputTail: trimOutput(`${stdout}\n${stderr}`),
    };
  }
}

function summarize(samples: Sample[]) {
  const commands = [...new Set(samples.map((sample) => sample.command))];
  return commands.map((command) => {
    const current = samples.filter((sample) => sample.command === command);
    const durations = current.map((sample) => sample.durationMs);
    return {
      command,
      runs: current.length,
      okRuns: current.filter((sample) => sample.ok).length,
      avgMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
    };
  });
}

const { commands, iterations, output, cwd } = parseArgs();

if (commands.length === 0) {
  console.error("No benchmark target provided. Use --command \"<real command>\" and optionally repeat --command.");
  process.exit(1);
}

console.log("📊 Starting measured benchmark run\n");
console.log(`Working directory: ${cwd}`);
console.log(`Iterations: ${iterations}`);
console.log(`Commands: ${commands.length}\n`);

const samples: Sample[] = [];
for (const command of commands) {
  console.log(`→ ${command}`);
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const sample = runMeasuredCommand(command, iteration, cwd);
    samples.push(sample);
    const status = sample.ok ? "OK" : "FAIL";
    console.log(`  [${status}] run ${iteration}/${iterations} ${sample.durationMs.toFixed(1)} ms`);
  }
}

const report: BenchmarkReport = {
  timestamp: new Date().toISOString(),
  cwd,
  iterations,
  measurementType: "measured-command-benchmark",
  commands,
  samples,
  summary: summarize(samples),
};

writeFileSync(join(process.cwd(), output), JSON.stringify(report, null, 2));

console.log("\nSummary");
for (const item of report.summary) {
  console.log(`- ${item.command}`);
  console.log(`  success: ${item.okRuns}/${item.runs}`);
  console.log(`  avg/min/max: ${item.avgMs.toFixed(1)} / ${item.minMs.toFixed(1)} / ${item.maxMs.toFixed(1)} ms`);
}
console.log(`\nReport saved to: ${join(process.cwd(), output)}`);
