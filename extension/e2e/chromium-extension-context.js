/**
 * Shared Chromium flags for loading an unpacked extension.
 * GitHub Actions / Linux often needs extra switches (shm, sandbox) to avoid flaky launches.
 */
import { chromium } from '@playwright/test';

const CI_CHROMIUM_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
];

export function extensionLaunchArgs(extensionDir) {
  const args = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];
  if (process.env.CI) args.unshift(...CI_CHROMIUM_ARGS);
  return args;
}

export function launchChromiumWithExtension(extensionDir) {
  return chromium.launchPersistentContext('', {
    args: extensionLaunchArgs(extensionDir),
  });
}
