import { chromium, type Browser, type LaunchOptions } from "playwright";

const MEMORY_ARGS = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--safebrowsing-disable-auto-update",
  // Prevent crashpad child processes from spawning.
  "--disable-crash-reporter",
  "--no-crashpad",
];

export async function launchChromium(
  options: LaunchOptions = {},
): Promise<Browser> {
  return chromium.launch({
    ...options,
    args: [...MEMORY_ARGS, ...(options.args ?? [])],
  });
}
