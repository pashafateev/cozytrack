import { describe, expect, it } from "vitest";
import { validateLiveKitBuildConfig } from "../scripts/validate-livekit-build-config.mjs";

const productionConfig = {
  VERCEL_ENV: "production",
  LIVEKIT_URL: "https://livekit.example.com",
  LIVEKIT_API_KEY: "test-api-key",
  LIVEKIT_API_SECRET: "test-api-secret",
};

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }

  throw new Error("Expected configuration validation to fail");
}

describe("validateLiveKitBuildConfig", () => {
  it("accepts complete production LiveKit configuration", () => {
    expect(() => validateLiveKitBuildConfig(productionConfig)).not.toThrow();
  });

  it.each(["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const)(
    "names missing %s without printing configured values",
    (name) => {
      const error = captureError(() =>
        validateLiveKitBuildConfig({ ...productionConfig, [name]: "" }),
      );

      expect(error.message).toContain(name);
      expect(error.message).not.toContain(productionConfig.LIVEKIT_API_KEY);
      expect(error.message).not.toContain(productionConfig.LIVEKIT_API_SECRET);
    },
  );

  it.each(["not-a-url", "http://livekit.example.com"])(
    "rejects invalid or non-HTTPS LIVEKIT_URL values without printing them",
    (livekitUrl) => {
      const error = captureError(() =>
        validateLiveKitBuildConfig({
          ...productionConfig,
          LIVEKIT_URL: livekitUrl,
        }),
      );

      expect(error.message).toContain("LIVEKIT_URL");
      expect(error.message).not.toContain(livekitUrl);
      expect(error.message).not.toContain(productionConfig.LIVEKIT_API_KEY);
      expect(error.message).not.toContain(productionConfig.LIVEKIT_API_SECRET);
    },
  );

  it.each([undefined, "development", "preview", "test"] as const)(
    "skips validation when VERCEL_ENV is %s",
    (vercelEnv) => {
      expect(() => validateLiveKitBuildConfig({ VERCEL_ENV: vercelEnv })).not.toThrow();
    },
  );
});
