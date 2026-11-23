import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredVariables = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
];

/** @param {Record<string, string | undefined>} env */
export function validateLiveKitBuildConfig(env) {
  if (env.VERCEL_ENV !== "production") return;

  const errors = requiredVariables
    .filter((name) => !env[name]?.trim())
    .map((name) => `${name} is required`);

  const livekitUrl = env.LIVEKIT_URL?.trim();
  if (livekitUrl && !isValidHttpsUrl(livekitUrl)) {
    errors.push("LIVEKIT_URL must be a valid HTTPS URL");
  }

  if (errors.length > 0) {
    throw new Error(
      ["Production LiveKit configuration is invalid:", ...errors.map((error) => `- ${error}`)].join(
        "\n",
      ),
    );
  }
}

/** @param {string} value */
function isValidHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function runValidation() {
  try {
    validateLiveKitBuildConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Production LiveKit configuration is invalid",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runValidation();
}
