import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
const dataDir = mkdtempSync(join(tmpdir(), 'zuno-e2e-data-'));
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    launchOptions: {
      executablePath: process.env.CI ? undefined : process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `SESSION_SECRET=e2e-only-secret-not-for-production-123456 PUBLIC_ORIGIN=http://127.0.0.1:3000 DATA_DIR=${dataDir} npm start`,
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: false,
  },
});
