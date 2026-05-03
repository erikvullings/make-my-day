import { type Browser, type Page } from "playwright";
import { launchChromium } from "../browser.js";
import type { WebsiteScraperFetcherConfig, CalendarEvent } from "./types.js";

interface ScrapedEvent {
  date: string;
  time: string;
  title: string;
  location?: string;
}

async function loginToSite(
  page: Page,
  config: WebsiteScraperFetcherConfig,
): Promise<void> {
  if (!config.loginUrl || !config.username || !config.password) {
    throw new Error(
      "loginUrl, username, and password are required for scraping",
    );
  }

  await page.goto(config.loginUrl, { waitUntil: "networkidle" });

  await page.fill(
    'input[name="username"], input[id="username"], input[type="email"], input[id="email"]',
    config.username,
  );
  await page.fill(
    'input[name="password"], input[id="password"], input[type="password"]',
    config.password,
  );

  await page.click(
    'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")',
  );

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {
    console.log("Wait for networkidle timed out, continuing...");
  });

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/signin")) {
    throw new Error("Login failed - stayed on login page");
  }

  console.log("Logged in successfully");
}

async function scrapeEvents(
  page: Page,
  config: WebsiteScraperFetcherConfig,
): Promise<ScrapedEvent[]> {
  if (!config.targetUrl) {
    throw new Error("targetUrl is required");
  }

  await page.goto(config.targetUrl, { waitUntil: "networkidle" });

  await page.waitForTimeout(2000);

  const events: ScrapedEvent[] = [];

  const eventSelectors = [
    ".event",
    ".appointment",
    ".agenda-item",
    ".schedule-item",
    '[class*="event"]',
    '[class*="appointment"]',
    '[class*="agenda"]',
    "tr.event",
    "div.event-card",
  ];

  for (const selector of eventSelectors) {
    const elements = await page.$$(selector);
    if (elements.length > 0) {
      console.log(
        `Found ${elements.length} events using selector: ${selector}`,
      );

      for (const el of elements) {
        const text = await el.textContent();
        if (text) {
          const dateMatch = text.match(
            /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}/,
          );
          const timeMatch = text.match(/\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm))?/);

          if (dateMatch || timeMatch) {
            events.push({
              date: dateMatch ? normalizeDate(dateMatch[0]) : getTodayDate(),
              time: timeMatch ? normalizeTime(timeMatch[0]) : "00:00",
              title: extractTitle(text),
            });
          }
        }
      }

      if (events.length > 0) break;
    }
  }

  const bodyText = await page.textContent("body");
  if (events.length === 0 && bodyText) {
    console.log(
      "No events found with standard selectors, trying text parsing...",
    );
    const lines = bodyText.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const dateMatch = line.match(/\d{4}-\d{2}-\d{2}/);
      const timeMatch = line.match(/\d{1,2}:\d{2}/);

      if (dateMatch && (timeMatch || line.length < 50)) {
        events.push({
          date: dateMatch[0],
          time: timeMatch ? timeMatch[0] : "00:00",
          title: line
            .replace(dateMatch[0], "")
            .replace(timeMatch?.[0] || "", "")
            .trim()
            .slice(0, 50),
        });
      }
    }
  }

  return events;
}

function normalizeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return getTodayDate();
    }
    return date.toISOString().split("T")[0];
  } catch {
    return getTodayDate();
  }
}

function normalizeTime(timeStr: string): string {
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!match) return "00:00";

  let hours = parseInt(match[1], 10);
  const minutes = match[2];

  if (timeStr.toLowerCase().includes("pm") && hours < 12) {
    hours += 12;
  } else if (timeStr.toLowerCase().includes("am") && hours === 12) {
    hours = 0;
  }

  return `${hours.toString().padStart(2, "0")}:${minutes}`;
}

function extractTitle(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines[0]?.trim().slice(0, 50) || "Event";
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

export async function scrapeAgenda(
  config: WebsiteScraperFetcherConfig,
): Promise<CalendarEvent[]> {
  let browser: Browser | null = null;
  let context: any = null;

  try {
    browser = await launchChromium({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();

    await loginToSite(page, config);
    const events = await scrapeEvents(page, config);

    const result: CalendarEvent[] = events.map((event) => {
      const eventDate = new Date(event.date);
      return {
        date: event.date,
        dayName: eventDate.toLocaleDateString("en-US", { weekday: "long" }),
        time: event.time,
        title: event.title,
        location: event.location,
      };
    });

    console.log(`Scraped ${result.length} events`);
    return result;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
