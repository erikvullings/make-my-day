import { type Browser, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { createInterface } from "readline";
import * as OTPAuth from "otpauth";
import { launchChromium } from "../browser.js";
import type { CarenFetcherConfig, CalendarEvent } from "./types.js";

const DEFAULT_LOGIN_URL = "https://www.caren.nl/auth/login";
const DEFAULT_AGENDA_URL = "https://caren.nl";
const SESSION_DIR = path.join(
  process.env.CONFIG_DIR || path.join(os.homedir(), ".caren-sessions"),
  ".caren-sessions",
);

interface CarenSession {
  cookies: { name: string; value: string; domain: string; path: string }[];
  localStorage: Record<string, string>;
  lastAuth: string;
}

function getSessionPath(configId: string): string {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
  return path.join(SESSION_DIR, `${configId}.json`);
}

function loadSession(configId: string): CarenSession | null {
  const sessionPath = getSessionPath(configId);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
  } catch {
    return null;
  }
}

function saveSession(configId: string, session: CarenSession): void {
  const sessionPath = getSessionPath(configId);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

async function restoreSession(
  context: any,
  session: CarenSession,
): Promise<boolean> {
  try {
    for (const cookie of session.cookies) {
      await context.addCookies([cookie]);
    }
    return true;
  } catch {
    return false;
  }
}

async function saveSessionFromContext(
  context: any,
  configId: string,
): Promise<CarenSession> {
  const cookies = await context.cookies();
  const page = await context.newPage();
  const localStorageData: Record<string, string> = {};

  try {
    await page.goto(DEFAULT_AGENDA_URL, {
      waitUntil: "load",
      timeout: 5000,
    });
    const storage = await page.evaluate(() => {
      const result: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key) || "";
      }
      return result;
    });
    Object.assign(localStorageData, storage);
  } catch {
  } finally {
    await page.close();
  }

  const session: CarenSession = {
    cookies,
    localStorage: localStorageData,
    lastAuth: new Date().toISOString(),
  };
  saveSession(configId, session);
  return session;
}

/** Returns true when the URL is no longer on any Caren auth/2FA page. */
function isAuthPage(url: string): boolean {
  return (
    url.includes("/two_factor") ||
    url.includes("/inloggen") ||
    url.includes("/login") ||
    url.includes("/auth/")
  );
}

/**
 * Prompts the user to enter a 2FA code via stdin (works in a terminal or
 * `docker exec -it`). Times out after 120 seconds and throws so the caller
 * can decide what to do.
 */
async function promptForTotpCode(page: Page): Promise<void> {
  const TIMEOUT_MS = 120_000;
  console.log(
    "[Caren] Automatic TOTP failed. Enter the 6-digit code from your authenticator app",
  );
  console.log(
    `[Caren] (you have ${TIMEOUT_MS / 1000} seconds; use \`docker exec -it <container> sh\` if running in Docker)`,
  );

  const code = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("Timed out waiting for manual 2FA code"));
    }, TIMEOUT_MS);

    rl.question("Enter 2FA code: ", (answer: string) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer.trim());
    });
  });

  const totpField = await page.$(
    'input[name="totp"], input[id="two_factor_totp"]',
  );
  if (!totpField)
    throw new Error("[Caren] Could not find TOTP input field for manual entry");

  await totpField.fill(code);
  await page.click('input[type="submit"][name="commit"]');
  await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (isAuthPage(page.url()))
    throw new Error("[Caren] Manual 2FA code rejected");
  console.log("[Caren] Manual 2FA successful");
}

async function loginToCaren(
  page: Page,
  config: CarenFetcherConfig,
): Promise<void> {
  const username = process.env[config.usernameEnvVar || ""];
  const password = process.env[config.passwordEnvVar || ""];

  if (!username || !password) {
    throw new Error(
      `Username/password not found. Set ${config.usernameEnvVar} and ${config.passwordEnvVar} environment variables.`,
    );
  }

  const loginUrl = config.loginUrl || DEFAULT_LOGIN_URL;
  console.log(`[Caren] Navigating to login page: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "load", timeout: 15000 });

  // Caren may redirect straight to the dashboard if cookies are still valid.
  if (!isAuthPage(page.url())) {
    console.log(
      "[Caren] Already logged in (redirected away from auth page):",
      page.url(),
    );
    return;
  }

  // Dismiss cookie consent banners (common on EU sites)
  for (const selector of [
    'button:has-text("Accepteer")',
    'button:has-text("Accept")',
    'button:has-text("Akkoord")',
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[class*="cookie"]',
  ]) {
    const btn = await page.$(selector);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
      console.log(`[Caren] Dismissed cookie banner (${selector})`);
      break;
    }
  }

  // Resolve the email input — try several selector patterns
  const EMAIL_SELECTORS = [
    'input[name="email"]',
    'input[id="session_email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="gebruiker" i]',
  ];

  let emailFilled = false;
  for (const sel of EMAIL_SELECTORS) {
    const el = await page.$(sel);
    if (el) {
      console.log(`[Caren] Filling email (selector: ${sel})...`);
      await el.fill(username);
      emailFilled = true;
      break;
    }
  }

  if (!emailFilled) {
    // Diagnostic dump to help identify the correct selector
    const inputs = await page
      .$$eval("input", (els) =>
        els.map((el) => ({
          name: (el as HTMLInputElement).name,
          id: (el as HTMLInputElement).id,
          type: (el as HTMLInputElement).type,
          placeholder: (el as HTMLInputElement).placeholder,
        })),
      )
      .catch(() => []);
    console.error(
      "[Caren] Could not find email input. Available inputs:",
      JSON.stringify(inputs),
    );
    const screenshotPath = "/tmp/caren-login-debug.png";
    await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => {});
    console.error(`[Caren] Login page screenshot saved to ${screenshotPath}`);
    throw new Error(
      "[Caren] Could not fill email — login form selector not matched. See inputs above.",
    );
  }

  console.log("[Caren] Filling password...");
  await page.fill('input[name="password"], input[type="password"]', password);

  const rememberToggle = await page.$(".toggle__button, .toggle, label.toggle");
  if (rememberToggle) {
    await rememberToggle.click();
    console.log("[Caren] Checked remember me");
  }

  console.log("[Caren] Submitting login...");
  const submitClicked = await page
    .$('input[type="submit"][name="commit"]')
    .then(async (el) => {
      if (el) {
        await el.click();
        return true;
      }
      return false;
    });
  if (!submitClicked) {
    // Broader fallbacks: any submit button or link with login-like text
    for (const sel of [
      'button[type="submit"]',
      'button:has-text("Inloggen")',
      'button:has-text("Log in")',
      'input[type="submit"]',
    ]) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        console.log(`[Caren] Submitted via ${sel}`);
        break;
      }
    }
  }

  await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {
    console.log("[Caren] Wait for load timed out, continuing...");
  });

  await page.waitForTimeout(2000);

  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  console.log("[Caren] Current URL after login:", currentUrl);

  if (isAuthPage(currentUrl)) {
    console.log("[Caren] 2FA verification required...");

    const totpSecret = config.totpSecretEnvVar
      ? process.env[config.totpSecretEnvVar]
      : null;

    // Try TOTP first if secret is available
    if (totpSecret) {
      // Sanitise: strip spaces/dashes that are sometimes present when copying
      // a secret from an authenticator setup page (e.g. "ABCD EFGH" → "ABCDEFGH").
      const cleanSecret = totpSecret.replace(/[\s-]/g, "").toUpperCase();
      const totp = new OTPAuth.TOTP({
        issuer: "Caren",
        label: "Caren",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(cleanSecret),
      });

      // Try the previous, current, and next 30-second windows to tolerate
      // clock drift on the server.
      const now = Math.floor(Date.now() / 1000);
      const windows = [-1, 0, 1].map((offset) =>
        totp.generate({ timestamp: (now + offset * 30) * 1000 }),
      );
      console.log(
        "[Caren] TOTP window codes (prev/cur/next):",
        windows.join(" / "),
      );

      for (let attempt = 0; attempt < windows.length; attempt++) {
        const totpCode = windows[attempt];
        console.log(
          "[Caren] Trying TOTP code (window",
          attempt - 1,
          "):",
          totpCode,
        );
        try {
          const totpField = await page.$(
            'input[name="totp"], input[id="two_factor_totp"]',
          );
          if (totpField) {
            await totpField.fill(totpCode);
            await page.click('input[type="submit"][name="commit"]');
            await page
              .waitForLoadState("load", { timeout: 10000 })
              .catch(() => {});
            await page.waitForTimeout(2000);

            const newUrl = page.url();
            console.log("[Caren] After submit, URL:", newUrl);
            // Success = navigated away from all auth pages (may land on / or /people/...)
            if (!isAuthPage(newUrl)) {
              console.log("[Caren] TOTP verification successful!");
              return;
            }

            // Still on auth page — go back to 2FA form for the next window
            if (attempt < windows.length - 1) {
              await page.goBack().catch(() => {});
              await page.waitForTimeout(1000);
            }
          }
        } catch (e) {
          console.log("[Caren] TOTP attempt failed:", e);
        }
      }
      console.log(
        "[Caren] TOTP failed for all time windows, falling back to manual entry...",
      );
    }

    // Manual fallback: prompt via stdin (works in terminal and with `docker exec -it`)
    await promptForTotpCode(page);
  }

  console.log("[Caren] Logged in successfully");
}

type CalendarOccurrence = {
  year: number;
  month: string; // zero-padded, e.g. "03"
  dayNum: number;
  timeText: string; // full range e.g. "08:05 - 08:25"
  eventType: string; // e.g. "1 Persoonlijke Verzorging"
  person: string; // e.g. "L.A.J.B."
};

/**
 * Switch the calendar to the list ("Lijst") view.
 * Caren uses a <select> element for view switching; we try both Dutch and
 * English labels in case the locale differs.
 */
async function switchToListView(page: Page): Promise<void> {
  const select = await page.$("select");
  if (!select) return;
  for (const label of ["Lijst", "List", "listWeek"]) {
    try {
      await select.selectOption({ label });
      await page
        .waitForSelector(
          "turbo-frame#occurrences_list, li.calendar__occurrences-list-item[aria-label]",
          { timeout: 10000 },
        )
        .catch(() => {});
      await page.waitForTimeout(1000);
      return;
    } catch {
      /* try next */
    }
  }
}

/**
 * Extract appointment events from the current Caren calendar page.
 *
 * Caren renders its own custom calendar (not FullCalendar).  The structure is:
 *
 *   <li class="calendar__occurrences-list-item"
 *       aria-label="dinsdag 31 maart 2026">       ← one per day
 *     <div class="calendar__list-item-wrapper">    ← one per occurrence
 *       <div class="calendar__occurrence-time">08:05 - 08:25</div>
 *       <div class="calendar__occurrence-title">1 Persoonlijke Verzorging</div>
 *       <ul class="calendar__occurrence-invitees-list">
 *         <li><span class="invitee-name">L.A.J.B.</span></li>
 *       </ul>
 *     </div>
 *   </li>
 *
 * All required data lives in the live DOM — no need to access <template> content.
 */
async function extractPageEvents(page: Page): Promise<CalendarOccurrence[]> {
  try {
    await page.waitForSelector(
      "turbo-frame#occurrences_list li.calendar__occurrences-list-item[aria-label], li.calendar__occurrences-list-item[aria-label]",
      { timeout: 10000 },
    );
    await page.waitForTimeout(1000);
  } catch {
    /* proceed anyway */
  }

  return page.evaluate(() => {
    const occurrences: {
      year: number;
      month: string;
      dayNum: number;
      timeText: string;
      eventType: string;
      person: string;
    }[] = [];

    const monthMap: Record<string, string> = {
      januari: "01",
      februari: "02",
      maart: "03",
      april: "04",
      mei: "05",
      juni: "06",
      juli: "07",
      augustus: "08",
      september: "09",
      oktober: "10",
      november: "11",
      december: "12",
    };

    const dayItems = document.querySelectorAll(
      "li.calendar__occurrences-list-item[aria-label]",
    );

    for (const dayItem of dayItems) {
      const ariaLabel =
        (dayItem as HTMLElement).getAttribute("aria-label") || "";
      // aria-label format: "dinsdag 31 maart 2026"
      const dateMatch = ariaLabel.match(
        /(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/i,
      );
      if (!dateMatch) continue;

      const dayNum = parseInt(dateMatch[1], 10);
      const month = monthMap[dateMatch[2].toLowerCase()] || "01";
      const year = parseInt(dateMatch[3], 10);

      // Each occurrence is in a .calendar__list-item-wrapper inside the day.
      for (const wrapper of dayItem.querySelectorAll(
        ".calendar__list-item-wrapper",
      )) {
        const timeText = (
          wrapper.querySelector(".calendar__occurrence-time")?.textContent || ""
        ).trim();
        if (!timeText) continue;

        const eventType =
          (
            wrapper.querySelector(".calendar__occurrence-title")?.textContent ||
            ""
          ).trim() || "Persoonlijke Verzorging";

        // There may be multiple invitees; join all names with ' / '.
        const names = Array.from(wrapper.querySelectorAll("span.invitee-name"))
          .map((el) => el.textContent?.trim())
          .filter(Boolean);
        const person = names.join(" / ");

        occurrences.push({ year, month, dayNum, timeText, eventType, person });
      }
    }

    return occurrences;
  });
}

async function parseAgenda(
  page: Page,
  config: CarenFetcherConfig,
): Promise<CalendarEvent[]> {
  console.log("[Caren] Navigating to home to resolve person ID...");
  await page.goto("https://caren.nl", { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(1500);

  // 1. Use hardcoded personId from config (most reliable)
  let personId: string | null = config.personId
    ? String(config.personId)
    : null;

  // 2. Check the URL we landed on after navigation
  if (!personId) {
    personId = page.url().match(/\/people\/(\d+)/)?.[1] ?? null;
  }

  // 3. Look for a /people/N/calendar link
  if (!personId) {
    const href = await page
      .$eval(
        'a[href*="/people/"][href*="/calendar"]',
        (el) => (el as HTMLAnchorElement).href,
      )
      .catch(() => null);
    personId = href?.match(/\/people\/(\d+)/)?.[1] ?? null;
  }

  // 4. Broader: any /people/N link on the page
  if (!personId) {
    const hrefs: string[] = await page
      .$$eval('a[href*="/people/"]', (els) =>
        els.map((el) => (el as HTMLAnchorElement).href),
      )
      .catch(() => []);
    console.log("[Caren] People links found on home page:", hrefs.slice(0, 10));
    for (const href of hrefs) {
      const match = href.match(/\/people\/(\d+)/);
      if (match) {
        personId = match[1];
        break;
      }
    }
  }

  if (!personId) {
    throw new Error(
      "[Caren] Could not resolve person ID. " +
        "Add `personId: <number>` to your caren config in the YAML file. " +
        "Run `bun run debug-caren.ts <configId>` to find it.",
    );
  }
  console.log("[Caren] Using person ID:", personId);

  const days = config.days || 7;
  const todayStr = new Date().toISOString().split("T")[0];
  const allData: CalendarOccurrence[] = [];
  const seen = new Set<string>();

  // Navigate to successive calendar weeks starting from today.
  // Using ?date= ensures we always land on the right week regardless of what
  // week was last viewed in the browser session.
  let weekDate = new Date();

  for (let attempt = 0; attempt < 4; attempt++) {
    const dateStr = weekDate.toISOString().split("T")[0];
    const calUrl = `https://caren.nl/people/${personId}/calendar?date=${dateStr}&view=list`;
    console.log(`[Caren] Attempt ${attempt + 1}: navigating to ${calUrl}`);

    await page.goto(calUrl, { waitUntil: "load", timeout: 15000 });
    await page
      .waitForSelector(
        "turbo-frame#occurrences_list, li.calendar__occurrences-list-item[aria-label]",
        { timeout: 10000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1000);

    let pageEvents = await extractPageEvents(page);
    if (pageEvents.length === 0) {
      // Fallback: if direct list URL still yields no events, try switching via UI.
      await switchToListView(page);
      pageEvents = await extractPageEvents(page);
    }
    console.log(`[Caren] Found ${pageEvents.length} events on this page`);

    for (const occ of pageEvents) {
      const key = `${occ.year}-${occ.month}-${String(occ.dayNum).padStart(2, "0")}|${occ.timeText}|${occ.person}`;
      if (!seen.has(key)) {
        seen.add(key);
        allData.push(occ);
      }
    }

    const futureDates = new Set(
      allData
        .map((o) => `${o.year}-${o.month}-${String(o.dayNum).padStart(2, "0")}`)
        .filter((d) => d >= todayStr),
    );
    if (futureDates.size >= days) break;

    // Advance by one week for the next iteration.
    weekDate.setDate(weekDate.getDate() + 7);
  }

  console.log(`[Caren] Total occurrences collected: ${allData.length}`);

  const events: CalendarEvent[] = allData.map((occ) => {
    const dateStr = `${occ.year}-${occ.month}-${String(occ.dayNum).padStart(2, "0")}`;
    // Compose title: "L.A.J.B., 1 Persoonlijke Verzorging" (name first — more important)
    const title = occ.person
      ? `${occ.person}, ${occ.eventType}`
      : occ.eventType;
    return {
      date: dateStr,
      dayName: new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
      }),
      time: occ.timeText, // full range "08:05 - 08:25" stored in `time`
      title,
    };
  });

  console.log(`[Caren] Returning ${events.length} events`);
  return events;
}

const CAREN_FETCH_TIMEOUT_MS = 3 * 60_000; // 3 minutes max per Caren fetch

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Caren] ${label} timed out after ${ms / 1000}s`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function fetchCarenAgenda(
  config: CarenFetcherConfig,
  configId: string = "default",
): Promise<CalendarEvent[]> {
  return withTimeout(
    _fetchCarenAgenda(config, configId),
    CAREN_FETCH_TIMEOUT_MS,
    "fetchCarenAgenda",
  );
}

async function _fetchCarenAgenda(
  config: CarenFetcherConfig,
  configId: string = "default",
): Promise<CalendarEvent[]> {
  let browser: Browser | null = null;
  let context: any = null;

  try {
    browser = await launchChromium({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const session = loadSession(configId);
    if (session) {
      console.log("[Caren] Restoring existing session...");
      await restoreSession(context, session);

      const page = await context.newPage();
      await page
        .goto(DEFAULT_AGENDA_URL, { waitUntil: "load", timeout: 5000 })
        .catch(() => {});

      const landedUrl = page.url();
      const isAuthenticated =
        landedUrl.includes("/people/") || landedUrl.includes("/settings");
      if (!isAuthenticated) {
        console.log(
          "[Caren] Session expired (landed on:",
          landedUrl,
          "), re-authenticating...",
        );
        await loginToCaren(page, config);
        await saveSessionFromContext(context, configId);
      } else {
        console.log("[Caren] Using existing session");
      }
      await page.close();
    } else {
      const page = await context.newPage();
      await loginToCaren(page, config);
      await saveSessionFromContext(context, configId);
      await page.close();
    }

    const page = await context.newPage();
    const events = await parseAgenda(page, config);
    await page.close();

    return events;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function fetchCarenAgendaHeadless(
  config: CarenFetcherConfig,
  configId: string = "default",
): Promise<CalendarEvent[]> {
  return withTimeout(
    _fetchCarenAgendaHeadless(config, configId),
    CAREN_FETCH_TIMEOUT_MS,
    "fetchCarenAgendaHeadless",
  );
}

async function _fetchCarenAgendaHeadless(
  config: CarenFetcherConfig,
  configId: string = "default",
): Promise<CalendarEvent[]> {
  let browser: Browser | null = null;
  let context: any = null;

  try {
    browser = await launchChromium({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    const session = loadSession(configId);
    let sessionValid = false;
    if (session) {
      console.log("[Caren] Restoring session...");
      await restoreSession(context, session);

      await page
        .goto("https://caren.nl", { waitUntil: "load", timeout: 5000 })
        .catch(() => {});
      const currentUrl = page.url();
      const isAuthenticated =
        currentUrl.includes("/people/") || currentUrl.includes("/settings");
      if (isAuthenticated) {
        console.log("[Caren] Session valid, using existing session");
        sessionValid = true;
      } else {
        console.log(
          "[Caren] Session expired (landed on:",
          currentUrl,
          "), re-authenticating...",
        );
      }
    }

    if (!sessionValid) {
      await loginToCaren(page, config);
      await saveSessionFromContext(context, configId);
    }

    const events = await parseAgenda(page, config);
    await page.close();

    return events;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
