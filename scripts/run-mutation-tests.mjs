import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const baseSha = process.env.MUTATION_BASE_SHA?.trim();
const hasBaseSha = Boolean(baseSha) && !/^0+$/.test(baseSha);
// A force-push can leave github.event.before pointing at a commit that is no longer fetchable.
const isReachableCommit = (sha) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status === 0;
const isValidBaseSha = hasBaseSha && isReachableCommit(baseSha);

if (hasBaseSha && !isValidBaseSha) {
  console.log(`Mutation base SHA ${baseSha} is not in the local history; running the full configured mutation suite.`);
}

let mutationArgs = ["run", "--incremental"];
const asMutationPattern = (file) =>
  file
    .split("/")
    .map((segment) => (/^\[.+\]$/.test(segment) ? "*" : segment))
    .join("/");

if (isValidBaseSha) {
  const changedPaths = execFileSync("git", ["diff", "--name-only", `${baseSha}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  const sourceFiles = changedPaths.filter(
    (file) => /^src\/.+\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts") && existsSync(file),
  );
  const unitTestFiles = changedPaths.filter((file) =>
    /^tests\/(?!integration\/).+\.test\.ts$/.test(file),
  );
  const unitTestSupportChanged = changedPaths.some(
    (file) =>
      file.startsWith("tests/") &&
      !file.startsWith("tests/integration/") &&
      !/\.test\.tsx?$/.test(file),
  );
  const mutationSetupChanged = changedPaths.some((file) =>
    [
      "package.json",
      "package-lock.json",
      "stryker.config.json",
      "vitest.config.ts",
      "tsconfig.json",
      "scripts/run-mutation-tests.mjs",
      ".github/workflows/mutation-testing.yml",
    ].includes(file),
  );
  const mutationSetupOnly =
    mutationSetupChanged &&
    sourceFiles.length === 0 &&
    unitTestFiles.length === 0 &&
    !unitTestSupportChanged;

  if (
    sourceFiles.length === 0 &&
    unitTestFiles.length === 0 &&
    !unitTestSupportChanged &&
    !mutationSetupChanged
  ) {
    console.log("No application TypeScript or unit-test changes; skipping mutation execution.");
    process.exit(0);
  }

  const mutateFiles =
    // Source changes need mutants only in changed application files. Test-only PRs use
    // the changed tests against the full application source tree.
    sourceFiles.length > 0
      ? [...new Set(sourceFiles.map(asMutationPattern))]
      : ["src/**/*.ts", "src/**/*.tsx"];
  mutationArgs.push("--mutate", mutateFiles.join(","));

  const survivingUnitTests = unitTestFiles.filter(existsSync);
  if (mutationSetupOnly) {
    mutationArgs.push("--dryRunOnly");
    console.log("Mutation setup changed; validating the full unit test runner without mutating source.");
  } else if (sourceFiles.length === 0 && survivingUnitTests.length > 0 && !unitTestSupportChanged) {
    mutationArgs.push("--testFiles", survivingUnitTests.join(","));
    console.log(
      `Testing ${survivingUnitTests.length} changed unit test file(s) against the application source tree.`,
    );
  } else if (sourceFiles.length > 0) {
    console.log(
      `Mutating ${sourceFiles.length} changed application source file(s) against the unit test suite.`,
    );
  } else if (unitTestSupportChanged) {
    console.log(
      "A unit-test support file changed; testing the full unit suite against the application source tree.",
    );
  } else {
    console.log("A unit test was removed; testing the remaining unit suite against the application source tree.");
  }

  if (unitTestSupportChanged) {
    mutationArgs.push("--force");
  }
} else if (!hasBaseSha) {
  console.log("No mutation base SHA provided; running the full configured mutation suite.");
}

// Run Stryker's JS entry point with the current Node binary. Spawning the .cmd shim on Windows
// without a shell is rejected by Node (EINVAL) since the CVE-2024-27980 fix.
const strykerEntry = "node_modules/@stryker-mutator/core/bin/stryker.js";
const result = spawnSync(process.execPath, [strykerEntry, ...mutationArgs], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
