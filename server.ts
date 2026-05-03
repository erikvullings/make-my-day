import http from "node:http";
import { launchChromium } from "./browser.js";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import yaml from "yaml";
import sharp from "sharp";
import "dotenv/config";

const PORT = parseInt(process.env.PORT || "7000", 10);
const REFRESH_INTERVAL =
  process.env.REFRESH_INTERVAL || "55 23,2,5,8,11,14,17,20 * * *"; // (23:55, 02:55, 05:55, 08:55, 11:55, 14:55, 17:55, 20:55)
const CONFIG_DIR = process.env.CONFIG_DIR || "./configs";
const CACHE_TTL_MS =
  parseInt(process.env.CACHE_TTL_MINUTES || "240", 10) * 60 * 1000;

import type {
  DayAgenda,
  QuoteFetcherConfig,
  JokeFetcherConfig,
  DashboardConfig,
} from "./fetchers/types.js";

interface DataCacheEntry {
  lastGenerated: Date;
  config: DashboardConfig; // enriched (fetchers applied)
  rawConfig: DashboardConfig; // raw yaml snapshot (for staleness check)
}

interface PngCacheEntry {
  buffer: Buffer;
  dataLastGenerated: Date; // mirrors DataCacheEntry.lastGenerated at render time
}

/** Data cache keyed by config id — shared across all pages of the same config. */
const dataCache = new Map<string, DataCacheEntry>();
/** PNG buffer cache keyed by `id-page`. */
const pngCache = new Map<string, PngCacheEntry>();
/** Last known non-empty agenda per config id. Survives cache clears so a
 *  scraper returning no results never wipes a previously good agenda. */
const lastGoodAgenda = new Map<string, DashboardConfig["agenda"]>();
/** In-flight data fetches keyed by config id. */
const inFlight = new Map<string, Promise<DataCacheEntry>>();
/** In-flight PNG renders keyed by `id-page`. */
const inFlightPng = new Map<string, Promise<PngCacheEntry>>();
let sharedBrowser: any = null;
let sharedPage: any = null;
let sharedBrowserStartedAt: number | null = null;
let sharedBrowserRenderCount = 0;
let refreshAllInProgress: Promise<void> | null = null;
let isShuttingDown = false;
const refreshRetryTimers = new Set<ReturnType<typeof setTimeout>>();

const SHARED_BROWSER_MAX_RENDERS = parseInt(
  process.env.SHARED_BROWSER_MAX_RENDERS || "200",
  10,
);
const SHARED_BROWSER_MAX_AGE_MS =
  parseInt(process.env.SHARED_BROWSER_MAX_AGE_MINUTES || "180", 10) * 60 * 1000;

async function closeSharedBrowser(reason: string): Promise<void> {
  if (!sharedBrowser) return;
  const browserToClose = sharedBrowser;
  sharedBrowser = null;
  sharedPage = null;
  sharedBrowserStartedAt = null;
  sharedBrowserRenderCount = 0;
  // Grab the OS process handle before close() so we can kill it afterwards.
  // browser.close() sends a CDP shutdown and resolves, but Chromium may still
  // be alive for a moment — its exited renderer children stay as zombies
  // parented to it until it exits. Sending SIGKILL immediately after close()
  // forces Chromium to exit, which reparents any zombie children to tini
  // (PID 1) so they are reaped promptly.
  const browserProcess =
    typeof browserToClose.process === "function"
      ? browserToClose.process()
      : null;
  try {
    await browserToClose.close();
  } catch {
    // ignore — we SIGKILL below regardless
  }
  try {
    browserProcess?.kill();
  } catch {
    // already gone
  }
  console.log(`[Browser] Closed shared browser (${reason})`);
}

function shouldRecycleSharedBrowser(): boolean {
  if (!sharedBrowser || sharedBrowserStartedAt === null) return false;
  const tooOld =
    Date.now() - sharedBrowserStartedAt > SHARED_BROWSER_MAX_AGE_MS;
  const tooManyRenders = sharedBrowserRenderCount >= SHARED_BROWSER_MAX_RENDERS;
  return tooOld || tooManyRenders;
}

async function getBrowser() {
  if (
    sharedBrowser &&
    (!sharedBrowser.isConnected() || shouldRecycleSharedBrowser())
  ) {
    await closeSharedBrowser("stale/disconnected");
  }
  if (!sharedBrowser) {
    sharedBrowser = await launchChromium({ headless: true });
    sharedBrowserStartedAt = Date.now();
    sharedBrowserRenderCount = 0;
  }
  return sharedBrowser;
}

// Returns the single reused page, creating it if needed. Reusing one page
// means one renderer process that never exits — no zombie children.
async function getSharedPage(browser: any) {
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await browser.newPage();
  }
  return sharedPage;
}

function loadConfig(id: string): DashboardConfig | null {
  const configPath = path.join(CONFIG_DIR, `${id}.yaml`);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return yaml.parse(content) as DashboardConfig;
  } catch (error) {
    console.error(`Error loading config ${id}:`, error);
    return null;
  }
}

/** Retry an async operation up to `maxAttempts` times with exponential backoff. */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 5000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        console.warn(
          `[${label}] Attempt ${attempt} failed, retrying in ${delay / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

const FETCHER_TIMEOUT_MS = 45_000;
const CAREN_FETCH_TIMEOUT_MS = 35_000;

/** Bound an async operation so one slow upstream cannot block the full refresh. */
async function withTimeout<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`[${label}] Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn().then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function runFetchers(
  config: DashboardConfig,
  configId: string = "default",
  staleConfig: DashboardConfig | null = null,
): Promise<DashboardConfig> {
  const result = { ...config };
  const fetchers = config.fetchers;

  if (!fetchers) {
    return result;
  }

  const promises: Promise<void>[] = [];
  const weatherCapture: {
    daily: import("./fetchers/types.js").WeatherData[] | null;
  } = { daily: null };

  /** Merge fetched events into result.agenda, sorting items by time in all cases. */
  function mergeEvents(
    events: Array<{
      date: string;
      dayName: string;
      time: string;
      title: string;
      location?: string;
    }>,
  ) {
    if (!events || events.length === 0) return;
    if (!result.agenda) result.agenda = [];

    const eventMap = new Map<string, DayAgenda>();
    for (const event of events) {
      if (!eventMap.has(event.date)) {
        eventMap.set(event.date, {
          date: event.date,
          dayName: event.dayName,
          items: [],
        });
      }
      eventMap.get(event.date)!.items.push({
        time: event.time,
        title: event.title,
        location: event.location,
      });
    }

    const existingDates = new Set(result.agenda.map((d) => d.date));
    for (const [, dayAgenda] of eventMap) {
      // Always sort items by time — source APIs do not guarantee order.
      dayAgenda.items.sort((a, b) => a.time.localeCompare(b.time));
      if (existingDates.has(dayAgenda.date)) {
        const existing = result.agenda!.find((d) => d.date === dayAgenda.date)!;
        existing.items = [...existing.items, ...dayAgenda.items];
        existing.items.sort((a, b) => a.time.localeCompare(b.time));
      } else {
        result.agenda!.push(dayAgenda);
      }
    }

    result.agenda.sort((a, b) => a.date.localeCompare(b.date));
  }

  if (fetchers.weather?.enabled) {
    promises.push(
      import("./fetchers/weather.js").then(async (weatherModule) => {
        try {
          const weatherData = await withTimeout(
            () =>
              retryWithBackoff(
                () => weatherModule.fetchWeather(fetchers.weather!),
                "Weather",
              ),
            "Weather",
            FETCHER_TIMEOUT_MS,
          );
          result.weather = weatherData.current;
          // Copy today's sunrise/sunset from daily forecast into the current weather object,
          // since the current-conditions API endpoint does not include these fields.
          if (weatherData.daily && weatherData.daily.length > 0) {
            const todayDaily = weatherData.daily[0];
            result.weather.sunrise = (todayDaily as any).sunrise;
            result.weather.sunset = (todayDaily as any).sunset;
          }
          // Store daily data for agenda mapping — applied after all fetchers finish
          // to avoid a race with calendar fetchers that populate result.agenda.
          weatherCapture.daily = weatherData.daily ?? null;
          console.log("[Weather] Fetched successfully");
        } catch (error) {
          console.error("[Weather] Failed after retries:", error);
          if (staleConfig?.weather) {
            result.weather = staleConfig.weather;
            console.log("[Weather] Using stale data as fallback");
          }
        }
      }),
    );
  }

  if (fetchers.googleCalendar?.enabled) {
    promises.push(
      import("./fetchers/google-calendar.js").then(async (calendarModule) => {
        try {
          const events = await withTimeout(
            () =>
              retryWithBackoff(
                () => calendarModule.fetchEvents(fetchers.googleCalendar!),
                "Google Calendar",
              ),
            "Google Calendar",
            FETCHER_TIMEOUT_MS,
          );
          mergeEvents(events);
          console.log("[Google Calendar] Fetched successfully");
        } catch (error) {
          console.error("[Google Calendar] Failed after retries:", error);
          if (staleConfig?.agenda) {
            console.log(
              "[Google Calendar] Stale agenda will be used as fallback",
            );
          }
        }
      }),
    );
  }

  if (fetchers.websiteScraper?.enabled) {
    promises.push(
      import("./fetchers/website-scraper.js").then(async (scraperModule) => {
        try {
          const events = await withTimeout(
            () =>
              retryWithBackoff(
                () => scraperModule.scrapeAgenda(fetchers.websiteScraper!),
                "Website Scraper",
              ),
            "Website Scraper",
            FETCHER_TIMEOUT_MS,
          );
          mergeEvents(events);
          console.log("[Website Scraper] Fetched successfully");
        } catch (error) {
          console.error("[Website Scraper] Failed after retries:", error);
          if (staleConfig?.agenda) {
            console.log(
              "[Website Scraper] Stale agenda will be used as fallback",
            );
          }
        }
      }),
    );
  }

  if (fetchers.caren?.enabled) {
    promises.push(
      import("./fetchers/caren.js").then(async (carenModule) => {
        try {
          const events = await withTimeout(
            () =>
              retryWithBackoff(
                () =>
                  carenModule.fetchCarenAgendaHeadless(
                    fetchers.caren!,
                    configId,
                  ),
                "Caren",
                2, // fewer retries since each attempt uses a full browser
              ),
            "Caren",
            CAREN_FETCH_TIMEOUT_MS,
          );
          mergeEvents(events);
          console.log("[Caren] Fetched successfully");
        } catch (error) {
          console.error("[Caren] Failed after retries:", error);
          if (staleConfig?.agenda) {
            console.log("[Caren] Stale agenda will be used as fallback");
          }
        }
      }),
    );
  }

  const quoteConfig = (fetchers.quote || config.quote) as
    | QuoteFetcherConfig
    | undefined;
  if (quoteConfig?.enabled || quoteConfig?.text) {
    promises.push(
      import("./fetchers/quote.js").then(async (quoteModule) => {
        try {
          const quote = await retryWithBackoff(
            () => quoteModule.fetchQuote(quoteConfig),
            "Quote",
          );
          result.quote = quote;
          console.log("[Quote] Fetched successfully");
        } catch (error) {
          console.error("[Quote] Failed after retries:", error);
          if (staleConfig?.quote) {
            result.quote = staleConfig.quote;
            console.log("[Quote] Using stale data as fallback");
          }
        }
      }),
    );
  }

  const jokeConfig = (fetchers.joke || config.joke) as
    | JokeFetcherConfig
    | undefined;
  if (jokeConfig?.enabled || jokeConfig?.text) {
    promises.push(
      import("./fetchers/quote.js").then(async (quoteModule) => {
        try {
          const joke = await retryWithBackoff(
            () => quoteModule.fetchJoke(jokeConfig, config.language),
            "Joke",
          );
          result.joke = joke;
          console.log("[Joke] Fetched successfully");
        } catch (error) {
          console.error("[Joke] Failed after retries:", error);
          if (staleConfig?.joke) {
            result.joke = staleConfig.joke;
            console.log("[Joke] Using stale data as fallback");
          }
        }
      }),
    );
  }

  await Promise.all(promises);

  // If agenda was fetched successfully, update the last-known-good store.
  const hasAgendaFetcher =
    fetchers.googleCalendar?.enabled ||
    fetchers.caren?.enabled ||
    fetchers.websiteScraper?.enabled;
  if (hasAgendaFetcher && result.agenda && result.agenda.length > 0) {
    lastGoodAgenda.set(configId, result.agenda);
  }

  // If no agenda was fetched, prefer (in order): stale cache → last good agenda.
  // This ensures a scraper returning no results never wipes a previously good agenda.
  if (hasAgendaFetcher && (!result.agenda || result.agenda.length === 0)) {
    const fallback =
      staleConfig?.agenda?.length
        ? staleConfig.agenda
        : lastGoodAgenda.get(configId);
    if (fallback) {
      result.agenda = fallback;
      console.log("[Agenda] Fetchers returned nothing — using last good agenda as fallback");
    }
  }

  // Apply daily weather to agenda days now that all calendar fetchers have run.
  const dailyWeatherList = weatherCapture.daily;
  if (dailyWeatherList && result.agenda) {
    for (const day of result.agenda) {
      const dailyWeather = dailyWeatherList.find((d) => d.date === day.date);
      if (dailyWeather) {
        day.weather = dailyWeather;
      }
    }
  }

  return result;
}

/** Strips past-day entries from agenda. Applied for page 1 only; page 2 (week
 *  view) needs past days of the current week so all 7 days are visible. */
function filterPastDates(config: DashboardConfig): DashboardConfig {
  if (!config.agenda) return config;
  const todayStr = new Date().toISOString().split("T")[0];
  return { ...config, agenda: config.agenda.filter((d) => d.date >= todayStr) };
}

function getTheme(config: DashboardConfig): "color" | "bw" | "grayscale4" {
  return config.theme || "bw";
}

function getHtmlPage(theme: string, page: number): string {
  if (page === 2) {
    return "dashboard-week.html";
  }
  if (theme === "color") return "dashboard.html";
  if (theme === "bw" || theme === "grayscale4") return "dashboard-bw.html";
  return "dashboard-bw.html";
}

/** Ensure enriched data for `id` is in dataCache, deduplicating concurrent fetches. */
function ensureDataFetch(
  id: string,
  freshConfig: DashboardConfig,
  now: Date,
  forceRefresh: boolean,
): Promise<DataCacheEntry> {
  const existing = dataCache.get(id);
  const hasAgendaFetcher =
    freshConfig.fetchers?.googleCalendar?.enabled ||
    freshConfig.fetchers?.caren?.enabled ||
    freshConfig.fetchers?.websiteScraper?.enabled;
  const hasEmptyAgenda =
    hasAgendaFetcher &&
    (!existing?.config.agenda || existing.config.agenda.length === 0);
  const hasEmptyWeather =
    freshConfig.fetchers?.weather?.enabled && !existing?.config.weather;
  const dataStale =
    forceRefresh ||
    !existing ||
    hasEmptyAgenda ||
    hasEmptyWeather ||
    now.getTime() - existing.lastGenerated.getTime() > CACHE_TTL_MS ||
    JSON.stringify(existing.rawConfig) !== JSON.stringify(freshConfig);

  if (!dataStale) {
    const age = Math.round(
      (now.getTime() - existing!.lastGenerated.getTime()) / 1000,
    );
    console.log(`[Cache] HIT  ${id} (age: ${age}s)`);
    return Promise.resolve(existing!);
  }

  if (!inFlight.has(id)) {
    console.log(`[Cache] MISS ${id}${forceRefresh ? " (forced)" : ""}`);
    const rawConfigSnapshot = JSON.parse(JSON.stringify(freshConfig));
    const staleData = existing?.config ?? null;
    const fetchPromise = runFetchers(freshConfig, id, staleData).then(
      (result) => {
        const entry: DataCacheEntry = {
          lastGenerated: now,
          config: result,
          rawConfig: rawConfigSnapshot,
        };
        dataCache.set(id, entry);
        inFlight.delete(id);
        return entry;
      },
    );
    inFlight.set(id, fetchPromise);
  }

  return inFlight.get(id)!;
}

async function refreshConfig(id: string, attempt = 1): Promise<void> {
  if (isShuttingDown) return;
  const freshConfig = loadConfig(id);
  if (!freshConfig) return;
  const now = new Date();
  console.log(
    `[Refresh] Fetching data for ${id}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
  );
  try {
    // Don't delete the cache before fetching — keep stale data available for fallback.
    // Only clear in-flight to allow a fresh fetch to start.
    inFlight.delete(id);
    const dataEntry = await ensureDataFetch(id, freshConfig, now, true);
    for (const page of [1, 2]) {
      const pngKey = `${id}-${page}`;
      pngCache.delete(pngKey);
      inFlightPng.delete(pngKey);
      let pageConfig =
        page === 1 ? filterPastDates(dataEntry.config) : dataEntry.config;
      if (page === 2)
        pageConfig = { ...pageConfig, cacheTime: now.toISOString() };
      try {
        const buffer = await generateImage(pageConfig, page);
        pngCache.set(pngKey, {
          buffer,
          dataLastGenerated: dataEntry.lastGenerated,
        });
        console.log(`[Refresh] PNG p${page} done for ${id}`);
      } catch (err: unknown) {
        console.error(`[Refresh] PNG p${page} failed for ${id}:`, err);
      }
    }
  } catch (err: unknown) {
    console.error(`[Refresh] Data fetch failed for ${id}:`, err);
    if (attempt < 3) {
      const delayMs = attempt * 60_000;
      console.log(`[Refresh] Retrying ${id} in ${delayMs / 1000}s...`);
      const timer = setTimeout(() => {
        refreshRetryTimers.delete(timer);
        if (isShuttingDown) return;
        refreshConfig(id, attempt + 1).catch((retryErr: unknown) =>
          console.error(`[Refresh] Retry failed for ${id}:`, retryErr),
        );
      }, delayMs);
      refreshRetryTimers.add(timer);
    } else {
      console.error(`[Refresh] Giving up on ${id} after ${attempt} attempts`);
    }
  }
}

async function refreshAllConfigs(): Promise<void> {
  if (isShuttingDown) return;
  if (refreshAllInProgress) {
    console.log("[Refresh] Skipping: refresh already running");
    await refreshAllInProgress;
    return;
  }

  refreshAllInProgress = (async () => {
    if (!fs.existsSync(CONFIG_DIR)) return;
    const ids = fs
      .readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(".yaml", ""));
    for (const id of ids) {
      if (isShuttingDown) break;
      await refreshConfig(id);
    }
  })();

  try {
    await refreshAllInProgress;
  } finally {
    refreshAllInProgress = null;
    // Close the browser after all screenshots are done. Renderer child processes
    // accumulate as zombies while the browser lives; closing here keeps the
    // window short (one batch of renders) rather than across the full uptime.
    await closeSharedBrowser("post-refresh");
  }
}

const IMAGE_RENDER_TIMEOUT_MS = 60_000;

/**
 * Floyd-Steinberg dithering to 4 gray levels (0, 85, 170, 255),
 * matching the Seeed reTerminal E1001 ePaper display capabilities.
 */
function ditherTo4LevelGrayscale(
  buffer: Buffer,
  width: number,
  height: number,
): Buffer {
  const levels = [0, 85, 170, 255];
  const output = Buffer.from(buffer); // copy

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = output[idx];
      let newPixel = levels[0];
      let minDiff = Math.abs(oldPixel - levels[0]);
      for (let i = 1; i < levels.length; i++) {
        const diff = Math.abs(oldPixel - levels[i]);
        if (diff < minDiff) {
          minDiff = diff;
          newPixel = levels[i];
        }
      }
      output[idx] = newPixel;
      const err = oldPixel - newPixel;
      if (x + 1 < width)
        output[idx + 1] = Math.min(
          255,
          Math.max(0, output[idx + 1] + Math.round((err * 7) / 16)),
        );
      if (y + 1 < height) {
        if (x > 0)
          output[idx + width - 1] = Math.min(
            255,
            Math.max(0, output[idx + width - 1] + Math.round((err * 3) / 16)),
          );
        output[idx + width] = Math.min(
          255,
          Math.max(0, output[idx + width] + Math.round((err * 5) / 16)),
        );
        if (x + 1 < width)
          output[idx + width + 1] = Math.min(
            255,
            Math.max(0, output[idx + width + 1] + Math.round((err * 1) / 16)),
          );
      }
    }
  }

  return output;
}

/**
 * Floyd-Steinberg dithering to pure black (0) or white (255),
 * for binary ePaper displays (theme: bw).
 */
function ditherToBW(buffer: Buffer, width: number, height: number): Buffer {
  const output = Buffer.from(buffer); // copy

  // Pre-snap: clamp clearly-black and clearly-white pixels to exact values
  // before dithering to prevent anti-aliased edges from seeding noise into
  // neighboring solid-color areas.
  for (let i = 0; i < output.length; i++) {
    output[i] = output[i] < 64 ? 0 : output[i] > 192 ? 255 : output[i];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = output[idx];
      const newPixel = oldPixel >= 128 ? 255 : 0;
      output[idx] = newPixel;
      const err = oldPixel - newPixel;

      // Skip error diffusion for pixels already at a palette value — avoids
      // stray isolated pixels in large solid-color regions.
      if (err === 0) continue;

      if (x + 1 < width)
        output[idx + 1] = Math.min(
          255,
          Math.max(0, output[idx + 1] + Math.round((err * 7) / 16)),
        );
      if (y + 1 < height) {
        if (x > 0)
          output[idx + width - 1] = Math.min(
            255,
            Math.max(0, output[idx + width - 1] + Math.round((err * 3) / 16)),
          );
        output[idx + width] = Math.min(
          255,
          Math.max(0, output[idx + width] + Math.round((err * 5) / 16)),
        );
        if (x + 1 < width)
          output[idx + width + 1] = Math.min(
            255,
            Math.max(0, output[idx + width + 1] + Math.round((err * 1) / 16)),
          );
      }
    }
  }

  return output;
}

const SPECTRA6_PALETTE: Array<[number, number, number]> = [
  [0, 0, 0], // Black
  [255, 255, 255], // White
  [255, 0, 0], // Red
  [0, 255, 0], // Green
  [0, 0, 255], // Blue
  [255, 255, 0], // Yellow
];

/**
 * Floyd-Steinberg dithering to the 6-color Spectra 6 palette used by the
 * Seeed reTerminal E1002. Operates on raw RGB data (3 bytes per pixel).
 */
function ditherTo6Colors(
  buffer: Buffer,
  width: number,
  height: number,
): Buffer {
  const output = Buffer.from(buffer);

  // Pre-snap: pixels that are clearly black or white get forced to exact palette
  // values before dithering. This prevents anti-aliased SVG icons (rendered as
  // dark gray) and near-white backgrounds from picking up dithering noise.
  for (let i = 0; i < output.length; i += 3) {
    const r = output[i],
      g = output[i + 1],
      b = output[i + 2];
    if (r < 64 && g < 64 && b < 64) {
      output[i] = 0;
      output[i + 1] = 0;
      output[i + 2] = 0;
    } else if (r > 192 && g > 192 && b > 192) {
      output[i] = 255;
      output[i + 1] = 255;
      output[i + 2] = 255;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;

      const oldR = output[idx];
      const oldG = output[idx + 1];
      const oldB = output[idx + 2];

      // Find closest palette color by squared Euclidean distance
      let bestColor = SPECTRA6_PALETTE[0];
      let minDist = Infinity;
      for (const color of SPECTRA6_PALETTE) {
        const dr = oldR - color[0];
        const dg = oldG - color[1];
        const db = oldB - color[2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) {
          minDist = dist;
          bestColor = color;
        }
      }

      output[idx] = bestColor[0];
      output[idx + 1] = bestColor[1];
      output[idx + 2] = bestColor[2];

      // Skip error diffusion when the pixel is already close to a palette color
      // (e.g. anti-aliased black edges). This prevents noise from spreading into
      // neighboring solid-color areas. Threshold: ~32 per channel (32²×3 ≈ 3072).
      if (minDist < 3072) continue;

      const errR = oldR - bestColor[0];
      const errG = oldG - bestColor[1];
      const errB = oldB - bestColor[2];

      const spread = (dx: number, dy: number, factor: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const nIdx = (ny * width + nx) * 3;
        output[nIdx] = Math.min(
          255,
          Math.max(0, output[nIdx] + Math.round((errR * factor) / 16)),
        );
        output[nIdx + 1] = Math.min(
          255,
          Math.max(0, output[nIdx + 1] + Math.round((errG * factor) / 16)),
        );
        output[nIdx + 2] = Math.min(
          255,
          Math.max(0, output[nIdx + 2] + Math.round((errB * factor) / 16)),
        );
      };

      spread(1, 0, 7);
      spread(-1, 1, 3);
      spread(0, 1, 5);
      spread(1, 1, 1);
    }
  }

  return output;
}

async function generateImage(
  config: DashboardConfig,
  page: number = 1,
): Promise<Buffer> {
  const theme = getTheme(config);
  const htmlPage = getHtmlPage(theme, page);
  const width = config.width || 800;
  const height = config.height || 480;

  const htmlPath = path.join("./public", htmlPage);
  const jsPath = path.join(
    "./public",
    page === 2 ? "dashboard-week.js" : "dashboard.js",
  );
  const cssPath = path.join(
    "./public",
    page === 2 ? "styles-week.css" : "styles.css",
  );

  let html = fs.readFileSync(htmlPath, "utf-8");
  const configJson = JSON.stringify(config);
  const script = `<script>window.__INITIAL_CONFIG__ = ${configJson};</script>`;
  html = html.replace("</body>", `${script}</body>`);

  async function tryRender(browser: any): Promise<Buffer> {
    const pageInstance = await getSharedPage(browser);
    try {
      await pageInstance.setViewportSize({ width, height });
      await pageInstance.setContent(html, { waitUntil: "domcontentloaded" });
      await pageInstance.addStyleTag({ path: cssPath });
      await pageInstance.addScriptTag({ path: jsPath });
      await pageInstance.waitForSelector("#app", { timeout: 5000 });
      await pageInstance.waitForTimeout(500);
      const screenshot = await pageInstance.screenshot({
        type: "png",
        omitBackground: false,
        timeout: IMAGE_RENDER_TIMEOUT_MS,
      });
      if (theme === "bw") {
        // Convert to binary black/white for ePaper displays (Floyd-Steinberg dithering).
        const { data, info } = await sharp(Buffer.from(screenshot))
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const dithered = ditherToBW(data, info.width, info.height);
        return sharp(dithered, {
          raw: { width: info.width, height: info.height, channels: 1 },
        })
          .png({ compressionLevel: 9 })
          .toBuffer();
      }
      if (theme === "grayscale4") {
        // Convert to 4-level grayscale for Seeed reTerminal E1001 ePaper (Floyd-Steinberg dithering).
        const { data, info } = await sharp(Buffer.from(screenshot))
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const dithered = ditherTo4LevelGrayscale(data, info.width, info.height);
        return sharp(dithered, {
          raw: { width: info.width, height: info.height, channels: 1 },
        })
          .png({ compressionLevel: 9 })
          .toBuffer();
      }
      if (theme === "color") {
        // Convert to 6-color Spectra 6 palette for Seeed reTerminal E1002 (Floyd-Steinberg dithering).
        const { data, info } = await sharp(Buffer.from(screenshot))
          .removeAlpha()
          .toColorspace("srgb")
          .raw()
          .toBuffer({ resolveWithObject: true });
        const dithered = ditherTo6Colors(data, info.width, info.height);
        return sharp(dithered, {
          raw: { width: info.width, height: info.height, channels: 3 },
        })
          .png({ compressionLevel: 9 })
          .toBuffer();
      }
      return Buffer.from(screenshot);
    } finally {
      // Do not close the page — keeping it alive avoids spawning a new renderer
      // process per render, which was the source of zombie chrome-headless children.
    }
  }

  const renderWithTimeout = (browser: any): Promise<Buffer> =>
    Promise.race([
      tryRender(browser),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `generateImage timed out after ${IMAGE_RENDER_TIMEOUT_MS}ms`,
              ),
            ),
          IMAGE_RENDER_TIMEOUT_MS,
        ),
      ),
    ]);

  let browser = await getBrowser();
  try {
    const rendered = await renderWithTimeout(browser);
    sharedBrowserRenderCount += 1;
    return rendered;
  } catch (err) {
    // Browser may have died — reset and retry once with a fresh instance
    console.warn("Browser error, relaunching:", (err as Error).message);
    await closeSharedBrowser("render error");
    browser = await getBrowser();
    const rendered = await renderWithTimeout(browser);
    sharedBrowserRenderCount += 1;
    return rendered;
  }
}

async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/list") {
      const absolutePath = path.resolve("./configs");
      const files = fs
        .readdirSync(absolutePath)
        .filter((f) => f.endsWith(".yaml"));
      return new Response(
        JSON.stringify({
          dashboards: files.map((f) => f.replace(".yaml", "")),
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    async function serveHtml(
      id: string,
      page: number,
      responsive = false,
    ): Promise<Response> {
      const freshConfig = loadConfig(id);
      if (!freshConfig) {
        return new Response("Dashboard not found", { status: 404 });
      }

      try {
        const now = new Date();
        const dataEntry = await ensureDataFetch(id, freshConfig, now, false);
        const configWithData = dataEntry.config;

        const displayConfig =
          page === 1 ? filterPastDates(configWithData) : configWithData;
        // Bare /:id pages always render in color for best browser experience.
        const finalConfig = responsive
          ? { ...displayConfig, responsive: true, theme: "color" as const }
          : displayConfig;
        const theme = getTheme(finalConfig);
        const htmlPage = getHtmlPage(theme, page);

        const staticPath = path.join("./public", htmlPage);
        if (fs.existsSync(staticPath)) {
          let html = fs.readFileSync(staticPath, "utf-8");
          const configJson = JSON.stringify(finalConfig);
          const script = `<script>window.__INITIAL_CONFIG__ = ${configJson};</script>`;
          html = html.replace(
            /<script src="[^"]+\.js"><\/script>/,
            `${script}$&`,
          );

          return new Response(html, {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-cache, no-store, must-revalidate",
            },
          });
        }

        return new Response("HTML file not found", { status: 404 });
      } catch (error) {
        console.error("Error rendering HTML dashboard:", error);
        return new Response("Failed to render dashboard", { status: 500 });
      }
    }

    // /<CONFIG> — responsive HTML page (no extension)
    const bareMatch = pathname.match(/^\/([^/.]+)$/);
    if (bareMatch && !["list", "refresh"].includes(bareMatch[1])) {
      return serveHtml(bareMatch[1], 1, true);
    }

    const htmlMatch = pathname.match(/^\/(.+)\.html$/);
    if (htmlMatch) {
      const id = htmlMatch[1].replace(/-(\d+)$/, "");
      const pageMatch = htmlMatch[1].match(/-(\d+)$/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      return serveHtml(id, page);
    }

    const pngMatch = pathname.match(/^\/([^/]+)\.png$/);
    if (pngMatch) {
      let id = pngMatch[1];

      // Strip cache-buster timestamp (large number > 100) first, then check for page number.
      id = id.replace(/-\d{5,}$/, "");
      const pageMatch = id.match(/(.+)-(\d+)$/);
      const page = pageMatch ? parseInt(pageMatch[2], 10) : 1;
      if (pageMatch) {
        id = pageMatch[1];
      }

      const forceRefresh = url.searchParams.get("refresh") === "true";
      const pngKey = `${id}-${page}`;

      try {
        const now = new Date();
        const freshConfig = loadConfig(id);
        if (!freshConfig) {
          return new Response(
            JSON.stringify({ error: "Dashboard not found" }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const existingPng = pngCache.get(pngKey);
        const existingData = dataCache.get(id);
        // PNG is valid only if it was rendered from the current data generation.
        const pngValid =
          !forceRefresh &&
          existingPng &&
          existingData &&
          existingPng.dataLastGenerated.getTime() ===
            existingData.lastGenerated.getTime();

        if (!pngValid && !inFlightPng.has(pngKey)) {
          const pngFetch = ensureDataFetch(id, freshConfig, now, forceRefresh)
            .then(async (dataEntry) => {
              let pageConfig =
                page === 1
                  ? filterPastDates(dataEntry.config)
                  : dataEntry.config;
              if (page === 2) {
                pageConfig = { ...pageConfig, cacheTime: now.toISOString() };
              }
              const buffer = await generateImage(pageConfig, page);
              const newPng: PngCacheEntry = {
                buffer,
                dataLastGenerated: dataEntry.lastGenerated,
              };
              pngCache.set(pngKey, newPng);
              inFlightPng.delete(pngKey);
              return newPng;
            })
            .catch((err) => {
              inFlightPng.delete(pngKey);
              throw err;
            });
          inFlightPng.set(pngKey, pngFetch);
        }

        const pngEntry = pngValid
          ? existingPng!
          : await inFlightPng.get(pngKey)!;

        return new Response(pngEntry.buffer as unknown as BodyInit, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
            Expires: "0",
          },
        });
      } catch (error) {
        console.error("Error generating image:", error);
        return new Response(
          JSON.stringify({ error: "Failed to generate image" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    if (pathname.startsWith("/config/")) {
      const id = pathname.replace("/config/", "").replace(".yaml", "");
      const config = loadConfig(id);

      if (!config) {
        return new Response(JSON.stringify({ error: "Dashboard not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const yamlContent = fs.readFileSync(
        path.join(CONFIG_DIR, `${id}.yaml`),
        "utf-8",
      );
      return new Response(yamlContent, {
        headers: { "Content-Type": "text/yaml" },
      });
    }

    if (pathname === "/refresh" && req.method === "POST") {
      dataCache.clear();
      pngCache.clear();
      return new Response(JSON.stringify({ success: true }));
    }

    if (pathname.startsWith("/refresh/") && req.method === "POST") {
      const id = pathname.replace("/refresh/", "");
      dataCache.delete(id);
      for (const key of pngCache.keys()) {
        if (key === id || key.startsWith(`${id}-`)) {
          pngCache.delete(key);
        }
      }
      return new Response(JSON.stringify({ success: true, id }));
    }

    const staticExtensions = [
      ".html",
      ".js",
      ".css",
      ".png",
      ".jpg",
      ".ico",
      ".webmanifest",
    ];
    const staticFile = staticExtensions.some((ext) => pathname.endsWith(ext));

    if (staticFile || pathname === "/" || pathname.startsWith("/public")) {
      let filePath = pathname === "/" ? "/dashboard.html" : pathname;
      filePath = filePath.replace("/public", "");

      const absolutePath = path.join(process.cwd(), "public", filePath);

      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        const ext = path.extname(absolutePath);
        const contentTypes: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".ico": "image/x-icon",
          ".webmanifest": "application/manifest+json",
        };

        return new Response(fs.readFileSync(absolutePath), {
          headers: { "Content-Type": contentTypes[ext] || "text/plain" },
        });
      }
    }

  return new Response("Dashboard not found", { status: 404 });
}

const server = http.createServer(async (nodeReq, nodeRes) => {
  const host = nodeReq.headers.host || `localhost:${PORT}`;
  const fullUrl = `http://${host}${nodeReq.url}`;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    nodeReq.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    nodeReq.on("end", resolve);
  });
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const request = new Request(fullUrl, {
    method: nodeReq.method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
  try {
    const response = await handleRequest(request);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    nodeRes.writeHead(response.status, responseHeaders);
    const buffer = await response.arrayBuffer();
    nodeRes.end(Buffer.from(buffer));
  } catch (err) {
    console.error("[Server] Unhandled error:", err);
    nodeRes.writeHead(500);
    nodeRes.end("Internal Server Error");
  }
});
server.listen(PORT, "0.0.0.0");

// Default: 10 min before every 3rd hour, 05:50–20:50 (06:00–21:00 window)
const refreshTask = cron.schedule(REFRESH_INTERVAL, () => {
  console.log("[Cron] Starting scheduled refresh...");
  refreshAllConfigs().catch((err: unknown) =>
    console.error("[Cron] Refresh failed:", err),
  );
});

if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

console.log(`Server running on http://0.0.0.0:${PORT}`);
console.log(`Access from other devices using your server's IP address`);
console.log(`Configs directory: ${CONFIG_DIR}`);

// Warm the cache shortly after startup. A small delay lets the server
// finish binding before Chromium launches, which avoids a crash-loop in
// memory-constrained Docker containers where Chrome starts too aggressively.
setTimeout(
  () =>
    refreshAllConfigs().catch((err: unknown) =>
      console.error("[Startup] Initial refresh failed:", err),
    ),
  5_000,
);

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}, stopping gracefully...`);

  refreshTask.stop();
  for (const timer of refreshRetryTimers) {
    clearTimeout(timer);
  }
  refreshRetryTimers.clear();

  if (refreshAllInProgress) {
    try {
      await refreshAllInProgress;
    } catch (err) {
      console.error("[Shutdown] Waiting for refresh failed:", err);
    }
  }

  await closeSharedBrowser(`shutdown ${signal}`);

  try {
    server.close();
  } catch (err) {
    console.error("[Shutdown] Failed to stop server cleanly:", err);
  }

  process.exit(0);
}

process.once("SIGINT", () => {
  shutdown("SIGINT").catch((err) => {
    console.error("[Shutdown] SIGINT handler failed:", err);
    process.exit(1);
  });
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => {
    console.error("[Shutdown] SIGTERM handler failed:", err);
    process.exit(1);
  });
});
