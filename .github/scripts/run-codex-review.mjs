#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_LINE = /^model:\s*([^\s]+)\s*$/im;
const RECOMMENDED_FALLBACK =
  /until then,\s*use\s+[`"']?([a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?)[`"']?/i;

export function parseSelectedModel(output) {
  return output.match(MODEL_LINE)?.[1] ?? null;
}

export function parseRecommendedFallback(output) {
  return output.match(RECOMMENDED_FALLBACK)?.[1] ?? null;
}

function normalizeModel(model) {
  const normalized = model?.trim() ?? "";
  return normalized && !/[\r\n]/.test(normalized) ? normalized : null;
}

function attemptSucceeded(attempt) {
  return attempt.exitCode === 0 && attempt.output.trim() !== "";
}

function attemptFailure(label, attempt) {
  const emptyOutput = attempt.output.trim() === "" ? ", empty final message" : "";
  return `${label} failed (exit code ${attempt.exitCode}${emptyOutput})`;
}

export async function runReviewWithFallback({
  previousModel,
  fallbackModel,
  runAttempt,
  log = console.log,
}) {
  log("Running Codex review with the latest CLI and its default model.");
  const primary = await runAttempt(null);

  if (attemptSucceeded(primary)) {
    const successfulModel = parseSelectedModel(
      `${primary.stderr}\n${primary.stdout ?? ""}`,
    );
    if (successfulModel) {
      log(`Codex default-model review succeeded with ${successfulModel}.`);
    } else {
      log("Codex default-model review succeeded, but its model was not reported.");
    }
    return {
      output: primary.output,
      successfulModel,
      usedFallback: false,
    };
  }

  const primaryFailure = attemptFailure("Default Codex review", primary);
  log(`${primaryFailure}; selecting a fallback model.`);

  const fallbacks = [];
  const enqueueFallback = (model) => {
    const normalized = normalizeModel(model);
    if (normalized && !fallbacks.includes(normalized)) {
      fallbacks.push(normalized);
    }
  };
  enqueueFallback(previousModel);
  enqueueFallback(fallbackModel);
  enqueueFallback(
    parseRecommendedFallback(`${primary.stderr}\n${primary.stdout ?? ""}`),
  );

  if (fallbacks.length === 0) {
    throw new Error(
      `${primaryFailure}; no last-known-good or API-recommended fallback model was available.`,
    );
  }

  const fallbackFailures = [];
  for (let index = 0; index < fallbacks.length; index += 1) {
    const fallback = fallbacks[index];
    log(`Retrying Codex review with fallback model ${fallback}.`);
    const secondary = await runAttempt(fallback);
    if (attemptSucceeded(secondary)) {
      log(`Codex fallback review succeeded with ${fallback}.`);
      return {
        output: secondary.output,
        successfulModel:
          parseSelectedModel(`${secondary.stderr}\n${secondary.stdout ?? ""}`) ??
          fallback,
        usedFallback: true,
      };
    }

    const failure = attemptFailure(`Fallback ${fallback}`, secondary);
    fallbackFailures.push(failure);
    log(`${failure}; checking for another fallback model.`);
    enqueueFallback(
      parseRecommendedFallback(`${secondary.stderr}\n${secondary.stdout ?? ""}`),
    );
  }

  throw new Error(
    `${primaryFailure}; all fallback attempts failed: ${fallbackFailures.join("; ")}.`,
  );
}

async function runCodexAttempt({
  codexCommand,
  model,
  prompt,
  workingDirectory,
}) {
  const attemptDirectory = await mkdtemp(
    path.join(os.tmpdir(), "cozytrack-codex-review-"),
  );
  const outputFile = path.join(attemptDirectory, "final-message.md");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    workingDirectory,
    "--output-last-message",
    outputFile,
    "--color",
    "never",
  ];

  if (model) {
    args.push("--model", model);
  }
  args.push("--sandbox", "read-only");

  let stdout = "";
  let stderr = "";

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(codexCommand, args, {
        env: {
          ...process.env,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_github_action",
          FORCE_COLOR: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
      child.stdin.end(prompt);
    });

    const output = await readFile(outputFile, "utf8").catch(() => "");
    return { exitCode, output, stderr, stdout };
  } finally {
    await rm(attemptDirectory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument list near ${key ?? "<end>"}.`);
    }
    values.set(key.slice(2), value);
  }

  const required = (name) => {
    const value = values.get(name);
    if (!value) {
      throw new Error(`Missing required --${name} argument.`);
    }
    return value;
  };

  return {
    promptFile: required("prompt-file"),
    outputFile: required("output-file"),
    previousModelFile: values.get("previous-model-file") ?? null,
    stateFile: required("state-file"),
    workingDirectory: values.get("working-directory") ?? process.cwd(),
  };
}

async function readOptionalModel(file) {
  if (!file) return null;
  const value = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return normalizeModel(value);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const prompt = await readFile(options.promptFile, "utf8");
  const previousModel = await readOptionalModel(options.previousModelFile);

  const result = await runReviewWithFallback({
    previousModel,
    fallbackModel: process.env.CODEX_REVIEW_FALLBACK_MODEL,
    runAttempt: (model) =>
      runCodexAttempt({
        codexCommand: process.env.CODEX_COMMAND ?? "codex",
        model,
        prompt,
        workingDirectory: options.workingDirectory,
      }),
  });

  await mkdir(path.dirname(options.outputFile), { recursive: true });
  await writeFile(options.outputFile, `${result.output.trim()}\n`);

  const stateModel = result.successfulModel ?? previousModel;
  if (stateModel) {
    await mkdir(path.dirname(options.stateFile), { recursive: true });
    await writeFile(options.stateFile, `${stateModel}\n`);
  } else {
    console.warn(
      "Codex review succeeded, but no model identifier was available to persist.",
    );
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
