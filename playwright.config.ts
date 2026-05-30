import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.COZYTRACK_BROWSER_PORT ?? 3101);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  outputDir: "output/playwright/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
      },
    },
  ],
  webServer: {
    command: `./node_modules/.bin/next dev -H 127.0.0.1 -p ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
