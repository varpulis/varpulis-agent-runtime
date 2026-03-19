import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5199",
  },
  webServer: {
    command: "npx vite --port 5199",
    port: 5199,
    cwd: path.join(__dirname, "test-app"),
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
