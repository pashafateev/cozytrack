import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRecommendedFallback,
  parseSelectedModel,
  runReviewWithFallback,
} from "./run-codex-review.mjs";

test("uses the Codex default first and records the model that succeeds", async () => {
  const calls = [];

  const result = await runReviewWithFallback({
    previousModel: "gpt-prior-stable",
    runAttempt: async (model) => {
      calls.push(model);
      return {
        exitCode: 0,
        output: "No findings.",
        stderr: "model: gpt-default-preview\n",
      };
    },
  });

  assert.deepEqual(calls, [null]);
  assert.deepEqual(result, {
    output: "No findings.",
    successfulModel: "gpt-default-preview",
    usedFallback: false,
  });
});

test("falls back to the last model that completed successfully", async () => {
  const calls = [];

  const result = await runReviewWithFallback({
    previousModel: "gpt-prior-stable",
    runAttempt: async (model) => {
      calls.push(model);
      if (model === null) {
        return {
          exitCode: 1,
          output: "",
          stderr: "model: gpt-default-preview\nERROR: unavailable\n",
        };
      }
      return {
        exitCode: 0,
        output: "Fallback review.",
        stderr: `model: ${model}\n`,
      };
    },
  });

  assert.deepEqual(calls, [null, "gpt-prior-stable"]);
  assert.deepEqual(result, {
    output: "Fallback review.",
    successfulModel: "gpt-prior-stable",
    usedFallback: true,
  });
});

test("seeds the first fallback from the API recommendation", async () => {
  const calls = [];

  const result = await runReviewWithFallback({
    previousModel: null,
    runAttempt: async (model) => {
      calls.push(model);
      if (model === null) {
        return {
          exitCode: 1,
          output: "",
          stderr:
            "The default model is unavailable. Until then, use `gpt-prior-stable`.\n",
        };
      }
      return {
        exitCode: 0,
        output: "Fallback review.",
        stderr: `model: ${model}\n`,
      };
    },
  });

  assert.deepEqual(calls, [null, "gpt-prior-stable"]);
  assert.equal(result.successfulModel, "gpt-prior-stable");
});

test("fails visibly when both the default and fallback attempts fail", async () => {
  const calls = [];

  await assert.rejects(
    runReviewWithFallback({
      previousModel: "gpt-prior-stable",
      runAttempt: async (model) => {
        calls.push(model);
        return {
          exitCode: model === null ? 1 : 2,
          output: "partial output that must not be posted",
          stderr: `model: ${model ?? "gpt-default-preview"}\nERROR: failed\n`,
        };
      },
    }),
    /Default Codex review failed.*fallback gpt-prior-stable failed/s,
  );

  assert.deepEqual(calls, [null, "gpt-prior-stable"]);
});

test("parses model identifiers without depending on a specific release", () => {
  assert.equal(
    parseSelectedModel("workdir: /tmp\nmodel: gpt-default-preview\n"),
    "gpt-default-preview",
  );
  assert.equal(
    parseRecommendedFallback("Until then, use `gpt-prior-stable`."),
    "gpt-prior-stable",
  );
  assert.equal(
    parseRecommendedFallback("Until then, use gpt-prior-stable."),
    "gpt-prior-stable",
  );
  assert.equal(parseRecommendedFallback("network timeout"), null);
});
