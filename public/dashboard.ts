import m from "mithril";
import { getTranslator } from "./translations.js";
import {
  getWeatherIcon,
  getWeatherIconColor,
  SVG_SUNRISE_BW,
  SVG_SUNRISE_COLOR,
  SVG_SUNSET_BW,
  SVG_SUNSET_COLOR,
  SVG_QUOTE_BW,
  SVG_QUOTE_COLOR,
  SVG_SMILE_BW,
  SVG_SMILE_COLOR,
  SVG_MEDICINE_BW,
  SVG_MEDICINE_COLOR,
} from "./weather-icons.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

interface AgendaItem {
  time: string;
  title: string;
  name?: string;
  location?: string;
}

interface DayAgenda {
  date: string;
  dayName: string;
  name?: string;
  items: AgendaItem[];
}

interface WeatherData {
  temp: number;
  tempMin?: number;
  tempMax?: number;
  tempUnit?: string;
  condition: string;
  icon: string;
  humidity?: number;
  wind?: number;
  windUnit?: string;
  windDir?: string;
  sunrise?: string;
  sunset?: string;
  location?: string;
}

interface Quote {
  text: string;
  author?: string;
}

interface Joke {
  text: string;
}

interface Medication {
  name: string;
  person?: string;
  time?: string;
  days?: string[];
  dates?: number[];
}

interface Labels {
  agenda?: string;
  weather?: string;
  noEvents?: string;
  humidity?: string;
  wind?: string;
  quote?: string;
  joke?: string;
  medication?: string;
}

/**
 * Font-size preset, Kindle-style. Governs all text on the dashboard.
 * Default: 'large' — suitable for 80+ users.
 * Options: 'small' | 'medium' | 'large' | 'xlarge'
 */
type FontSize = "small" | "medium" | "large" | "xlarge";

interface DashboardConfig {
  title?: string;
  language?: string;
  /** Controls all font sizes. Options: small, medium, large (default), xlarge. */
  fontSize?: FontSize;
  labels?: Labels;
  agenda?: DayAgenda[];
  weather?: WeatherData;
  quote?: Quote;
  joke?: Joke;
  medication?: Medication[];
  theme?: "color" | "bw";
  width?: number;
  height?: number;
  responsive?: boolean;
  /** Enable anti-aliasing for devices that support it (e.g. e1001). Default: false. */
  antiAliasing?: boolean;
}

// ── Font metrics (px) per preset ──────────────────────────────────────────────

interface FontMetrics {
  header: number;
  day: number;
  item: number;
  weather: number;
  quote: number;
}

const FONT_SIZES: Record<FontSize, FontMetrics> = {
  small: { header: 14, day: 12, item: 11, weather: 11, quote: 11 },
  medium: { header: 16, day: 14, item: 13, weather: 12, quote: 12 },
  large: { header: 19, day: 17, item: 15, weather: 14, quote: 13 },
  xlarge: { header: 23, day: 20, item: 18, weather: 17, quote: 16 },
};

// ── Config resolution ─────────────────────────────────────────────────────────

function getConfigFromURL(): DashboardConfig {
  if (typeof window !== "undefined" && (window as any).__INITIAL_CONFIG__) {
    return (window as any).__INITIAL_CONFIG__;
  }

  const params = new URLSearchParams(window.location.search);
  const configParam = params.get("config");

  if (configParam) {
    try {
      return JSON.parse(decodeURIComponent(configParam));
    } catch {
      console.error("Failed to parse config from URL");
    }
  }

  return getDefaultConfig();
}

function getDefaultConfig(): DashboardConfig {
  return {
    title: "Moeders Agenda",
    language: "nl",
    fontSize: "large",
    theme: "bw",
    agenda: [
      {
        date: new Date().toISOString().split("T")[0],
        dayName: "Today",
        items: [{ time: "09:00", title: "Voorbeeld afspraak" }],
      },
    ],
    weather: { temp: 14, condition: "Cloudy", icon: "⛅" },
  };
}

// ── Runtime setup ─────────────────────────────────────────────────────────────

const config = getConfigFromURL();
const language = config.language || "nl";
const t = getTranslator(language);
const labels: Labels = config.labels || {
  agenda: t("agenda"),
  weather: t("weather"),
  noEvents: t("noEvents"),
  humidity: t("humidity"),
  wind: t("wind"),
  quote: t("quote"),
  joke: t("joke"),
  medication: t("medication"),
};

// Push font-size CSS variables onto :root so every CSS rule using var(--fs-*)
// responds to the configured level without any class-name gymnastics.
const fontSize: FontSize = (config.fontSize as FontSize) || "large";
const fm = FONT_SIZES[fontSize] || FONT_SIZES.large;
const root = document.documentElement;
root.style.setProperty("--fs-header", `${fm.header}px`);
root.style.setProperty("--fs-day", `${fm.day}px`);
root.style.setProperty("--fs-item", `${fm.item}px`);
root.style.setProperty("--fs-weather", `${fm.weather}px`);
const theme = config.theme || "bw";
// BW display: quote/joke font matches the weather panel size (one step larger than default quote).
root.style.setProperty(
  "--fs-quote",
  theme === "color" ? `${fm.quote}px` : `${fm.weather}px`,
);

const weatherIconForTheme =
  theme === "color" ? getWeatherIconColor : getWeatherIcon;
const sunriseIconForTheme =
  theme === "color" ? SVG_SUNRISE_COLOR : SVG_SUNRISE_BW;
const sunsetIconForTheme = theme === "color" ? SVG_SUNSET_COLOR : SVG_SUNSET_BW;
const quoteIconForTheme = theme === "color" ? SVG_QUOTE_COLOR : SVG_QUOTE_BW;
const smileIconForTheme = theme === "color" ? SVG_SMILE_COLOR : SVG_SMILE_BW;
const medicineIconForTheme =
  theme === "color" ? SVG_MEDICINE_COLOR : SVG_MEDICINE_BW;

// Set data-theme attribute so CSS [data-theme="color"] overrides activate.
root.setAttribute("data-theme", theme);
if (config.responsive) root.setAttribute("data-responsive", "true");
if (config.antiAliasing) root.setAttribute("data-aa", "true");

/**
 * Estimated rendered line height for a given font size.
 * Uses a 1.2× multiplier — empirically accurate for Courier New monospace.
 */
function lineH(px: number): number {
  return Math.ceil(px * 1.2);
}

/**
 * Calculates how many agenda days fit inside the left-panel card given the
 * active font size.  All constants match styles-e1001.css:
 *
 *   container padding : 12 px × 2 = 24 px
 *   card border       :  2 px × 2 =  4 px
 *   card padding      : 10 px × 2 = 20 px
 *   card-header chrome: pb(3) + border(2) + mb(6) = 11 px  (+ font line-height)
 *
 *   day-header margins: top = 0 (first) or 6 px, bottom = 2 px
 *   agenda-item height: line-height + 2 px top-pad + 2 px bot-pad + 1 px border = +5
 *   agenda-day gap    : 4 px bottom margin between days (last day's margin is
 *                       clipped by overflow:hidden and does not consume space)
 */
function calcVisibleDays(): DayAgenda[] {
  const all = config.agenda || [];
  if (all.length === 0) return [];
  if (config.responsive) return all;

  const totalH = config.height || 480;
  // container padding 8px×2=16, card border 2px×2=4, card padding 10px×2=20
  const cardContentH = totalH - 16 - 4 - 20;
  const cardHeaderH = lineH(fm.header) + 11;
  const available = cardContentH - cardHeaderH;

  let used = 0;
  const visible: DayAgenda[] = [];

  for (let i = 0; i < all.length; i++) {
    const isFirst = i === 0;
    const dayHeaderH = lineH(fm.day) + (isFirst ? 2 : 10);
    const itemCount = Math.max(all[i].items.length, 1); // "no events" still 1 row
    const itemsH = itemCount * (lineH(fm.item) + 5);
    // The 8 px bottom margin between days — the last day's margin is clipped by
    // overflow:hidden and never actually consumes layout space.
    const marginH = isFirst || i === all.length - 1 ? 0 : 8;
    const dayH = marginH + dayHeaderH + itemsH;

    if (visible.length > 0 && used + dayH > available) break;
    used += dayH;
    visible.push(all[i]);
  }

  return visible.length ? visible : all.slice(0, 1);
}

const visibleAgenda = calcVisibleDays();
const todayDate = new Date().toISOString().split("T")[0];

const MONTH_KEYS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/**
 * Format a date as "31 Martie 2026" using the translations table for full
 * month names so locale is always correct regardless of browser locale support.
 */
function formatHeaderDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDate();
  const monthFull = t(MONTH_KEYS[d.getMonth()]);
  const month = monthFull.charAt(0).toUpperCase() + monthFull.slice(1);
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert "Partly Cloudy" → "partlyCloudy" for translation key lookup. */
function conditionKey(condition: string): string {
  return condition.toLowerCase().replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
}

/**
 * Pass-through; the "Care: " prefix is no longer injected by the Caren fetcher.
 * Event titles now come directly from Caren, e.g. "1 Persoonlijke Verzorging, L.A.J.B."
 */
function translateTitle(title: string): string {
  return title;
}

// ── Inline SVG assets ─────────────────────────────────────────────────────────
// Embedded directly so Playwright's setContent() can render them without a
// server request.  Sizing is set via width/height attributes; fill inherits
// from CSS `currentColor`.

const SVG_SUNRISE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="138 117 924 945" width="14" height="14" fill="currentColor"><path d="M353 776c20 0 35 -16 35 -35 0 -117 95 -212 212 -212 117 0 212 95 212 212 0 20 16 35 35 35s35 -16 35 -35c0 -156 -127 -282 -282 -282 -156 0 -282 127 -282 282 0 20 16 35 35 35zm459 212H388c-19 0 -35 16 -35 35s16 35 35 35h424c20 0 35 -16 35 -35 0 -19 -16 -35 -35 -35zm141 -141H247c-19 0 -35 16 -35 35s16 35 35 35h706c20 0 35 -16 35 -35 0 -20 -16 -35 -35 -35zM562 212h75c14 0 23 -16 15 -27l-38 -56c-7 -10 -22 -10 -29 0l-38 56c-8 12 1 27 15 27zm2 106v35c0 20 16 35 35 35s35 -16 35 -35V318c0 -19 -16 -35 -35 -35 -19 0 -35 16 -35 35M375 423c7 11 18 18 31 18 6 0 12 -1 18 -5 17 -10 23 -31 13 -48l-18 -31c-10 -17 -31 -23 -48 -13 -17 10 -23 31 -13 48zM216 560l31 18a35 35 0 0 0 18 5c12 0 24 -6 31 -18 10 -17 4 -38 -13 -48l-31 -18c-17 -10 -38 -4 -48 13 -10 17 -4 38 13 48zm32 181c0 -19 -16 -35 -35 -35h-35c-19 0 -35 16 -35 35s16 35 35 35h35c20 0 35 -16 35 -35m776 -35h-35c-19 0 -35 16 -35 35s16 35 35 35h35c20 0 35 -16 35 -35S1043 706 1024 706m-87 -124c6 0 12 -1 18 -5l31 -18c17 -10 23 -31 13 -48 -10 -17 -31 -23 -48 -13l-31 18c-17 10 -23 31 -13 48 7 11 18 18 31 18m-160 -147c6 3 12 5 18 5 12 0 24 -6 31 -18l18 -31c10 -17 4 -38 -13 -48 -17 -10 -38 -4 -48 13l-18 31c-10 17 -4 38 13 48"/></svg>`;

const SVG_SUNSET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="138 138 924 945" width="14" height="14" fill="currentColor"><path d="M812 847H388c-19 0 -35 16 -35 35s16 35 35 35h424c20 0 35 -16 35 -35 0 -20 -16 -35 -35 -35zm141 -141H247c-19 0 -35 16 -35 35s16 35 35 35h706c20 0 35 -16 35 -35 0 -19 -16 -35 -35 -35zM638 988h-75c-14 0 -22 16 -15 27l38 56c7 11 22 11 29 0l38 -56c8 -12 -1 -27 -15 -27zM600 247c20 0 35 -16 35 -35v-35c0 -19 -16 -35 -35 -35s-35 16 -35 35v35c0 19 16 35 35 35m-225 34c7 11 18 18 31 18 6 0 12 -1 18 -5 17 -10 23 -31 13 -48l-18 -31c-10 -17 -31 -23 -48 -13 -17 10 -23 31 -13 48zM216 419l31 18c6 3 12 5 18 5 12 0 24 -6 31 -18 10 -17 4 -38 -13 -48l-31 -18c-17 -10 -38 -4 -48 13 -10 17 -4 38 13 48zM247 600c0 -19 -16 -35 -35 -35h-35c-19 0 -35 16 -35 35s16 35 35 35h35c20 0 35 -16 35 -35m776 -35h-35c-19 0 -35 16 -35 35s16 35 35 35h35c20 0 35 -16 35 -35S1043 565 1024 565m-87 -124c6 0 12 -1 18 -5l31 -18c17 -10 23 -31 13 -48 -10 -17 -31 -23 -48 -13l-31 18c-17 10 -23 31 -13 48 7 11 18 18 31 18m-160 -147c6 3 12 5 18 5 12 0 24 -6 31 -18l18 -31c10 -17 4 -38 -13 -48 -17 -10 -38 -4 -48 13l-18 31c-10 17 -4 38 13 48M353 635h494c20 0 35 -16 35 -35 0 -156 -127 -282 -282 -282 -156 0 -282 127 -282 282 0 20 16 35 35 35z"/></svg>`;

// Quote icon (two open-bracket shapes) — used for both quote and joke cards.
const SVG_QUOTE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="116 209 967 782" width="22" height="22" fill="currentColor"><path d="M1031 213H711c-27 0 -49 22 -49 49v320c0 27 22 49 49 49h247v147c0 48 -39 87 -87 87h-24c-27 0 -49 22 -49 49v24c0 27 22 49 49 49h24c116 0 209 -94 209 -209l0 -147v-369c0 -27 -22 -49 -49 -49zm-542 0h-320c-27 0 -49 22 -49 49v320c0 27 22 49 49 49H416v147c0 48 -39 87 -87 87h-24c-27 0 -49 22 -49 49v24c0 27 22 49 49 49h24c116 0 209 -94 209 -209l0 -147v-369c0 -27 -22 -49 -49 -49z"/></svg>`;

const SVG_SMILE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="350 350 500 500"><path d="M600 354a246 246 0 0 0 -174 72c-46 46 -72 109 -72 174s26 128 72 174 109 72 174 72 128 -26 174 -72a246 246 0 0 0 72 -174 247 247 0 0 0 -72 -174 247 247 0 0 0 -174 -72m0 464a217 217 0 0 1 -154 -64c-41 -41 -64 -96 -64 -154s23 -113 64 -154 96 -64 154 -64 113 23 154 64a217 217 0 0 1 64 154 218 218 0 0 1 -64 154 218 218 0 0 1 -154 63"/><path d="M745 586H455c-4 0 -8 2 -10 4a14 14 0 0 0 -4 10c0 57 30 110 80 138 49 28 110 28 159 0s80 -81 80 -138c0 -4 -2 -8 -4 -10a14 14 0 0 0 -10 -4m-274 29h67v100a131 131 0 0 1 -67 -100m96 111V615h68v111a130 130 0 0 1 -68 0m97 -12V614h67a131 131 0 0 1 -67 100m-14 -172c4 0 8 -2 10 -4a14 14 0 0 0 4 -10 29 29 0 0 1 14 -25 29 29 0 0 1 29 0 29 29 0 0 1 14 25c0 5 3 10 7 13a14 14 0 0 0 14 0 14 14 0 0 0 7 -13 58 58 0 0 0 -29 -50 58 58 0 0 0 -58 0 58 58 0 0 0 -29 50c0 4 2 8 4 10a14 14 0 0 0 10 4zm-188 0c4 0 8 -2 10 -4a14 14 0 0 0 4 -10 29 29 0 0 1 14 -25 29 29 0 0 1 29 0 29 29 0 0 1 14 25c0 5 3 10 7 13a14 14 0 0 0 14 0 14 14 0 0 0 7 -13 58 58 0 0 0 -29 -50 58 58 0 0 0 -58 0 58 58 0 0 0 -29 50c0 4 2 8 4 10a14 14 0 0 0 10 4z"/></svg>`;

const SVG_MEDICINE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="30 183 1140 833" width="22" height="22" fill="currentColor"><path d="M1153 642c-40 -108 -144 -182 -261 -182 -8 0 -15 0 -22 1 -126 10 -228 104 -251 225 -3 17 -5 35 -5 53 0 6 0 12 1 19a268 268 0 0 0 5 39zm14 53L636 847c43 102 143 169 256 169 153 0 278 -125 278 -278 0 -14 -1 -29 -3 -43M87 667c-76 76 -76 200 0 276s200 76 276 0l195 -195 -268 -284z"/><path d="M624 541c5 -7 10 -14 16 -20 1 -1 2 -2 2 -3a324 324 0 0 1 18 -19c1 -1 2 -1 2 -2 6 -6 13 -12 20 -18l2 -2c7 -6 14 -11 22 -16l1 -1 24 -15a325 325 0 0 1 26 -13h1c9 -4 17 -7 26 -10a26 26 0 0 0 2 -1c9 -3 17 -5 26 -8 1 0 2 -1 3 -1a310 310 0 0 1 27 -5h2c1 -9 2 -19 2 -29 0 -52 -20 -101 -57 -138 -38 -38 -88 -57 -138 -57s-100 19 -138 57L329 424l235 250v1 -1c2 -9 4 -17 6 -25 0 -1 1 -2 1 -3 2 -8 5 -17 8 -25l1 -3c3 -8 7 -16 10 -24 1 -1 1 -2 2 -3a319 319 0 0 1 12 -23c1 -1 1 -2 2 -3a325 325 0 0 1 14 -21c1 -1 2 -2 2 -3z"/></svg>`;

// ── Components ────────────────────────────────────────────────────────────────

const WeatherCard: m.Component = {
  view: () =>
    config.weather
      ? m(
          ".card.weather-card",
          m(
            ".card-header",
            (labels.weather || t("weather")) +
              (config.weather!.location
                ? ` — ${config.weather!.location}`
                : ""),
          ),
          m(
            ".weather-main",
            m.trust(weatherIconForTheme(config.weather!.condition)),
            m(
              ".weather-temp-group",
              m(
                ".weather-temp",
                `${config.weather!.temp}°${config.weather!.tempUnit || "C"}`,
              ),
              config.weather!.humidity !== undefined
                ? m(".weather-humidity", `${config.weather!.humidity}%`)
                : null,
            ),
            config.weather!.sunrise || config.weather!.sunset
              ? m(
                  "span.sun-times",
                  config.weather!.sunrise
                    ? m(
                        "span.sun-item",
                        m.trust(sunriseIconForTheme),
                        ` ${config.weather!.sunrise}`,
                      )
                    : null,
                  config.weather!.sunset
                    ? m(
                        "span.sun-item",
                        m.trust(sunsetIconForTheme),
                        ` ${config.weather!.sunset}`,
                      )
                    : null,
                )
              : null,
          ),
          m(
            ".weather-details",
            m(
              ".weather-condition-wind",
              m(
                "span",
                t(conditionKey(config.weather!.condition)) ||
                  config.weather!.condition,
              ),
              config.weather!.wind !== undefined
                ? m(
                    "span",
                    `${t("wind")}: ${config.weather!.wind} ${config.weather!.windUnit || "km/h"}` +
                      `${config.weather!.windDir ? ` ${t(config.weather!.windDir)}` : ""}`,
                  )
                : null,
            ),
          ),
        )
      : null,
};

const QuoteCard: m.Component = {
  view: () =>
    config.quote
      ? m(
          ".card.quote-card",
          m("span.card-corner-icon", m.trust(quoteIconForTheme)),
          m(
            ".quote-content",
            m(".quote-text", config.quote!.text),
            config.quote!.author
              ? m(".quote-author", `— ${config.quote!.author}`)
              : null,
          ),
        )
      : null,
};

const JokeCard: m.Component = {
  view: () =>
    config.joke
      ? m(
          ".card.quote-card",
          m("span.card-corner-icon", m.trust(smileIconForTheme)),
          m(
            ".quote-content",
            {
              oncreate: ({ dom }: m.VnodeDOM) => {
                const container = dom as HTMLElement;
                const textEl = container.querySelector(
                  ".quote-text",
                ) as HTMLElement | null;
                if (!textEl) return;
                // .quote-content has height:100% and overflow:hidden, so its
                // clientHeight is the true available height for the text.
                const available = container.clientHeight - 4; // 4px = content padding-top
                let size = fm.quote;
                // textEl has no overflow:hidden, so its scrollHeight is its natural height.
                while (size > 7 && textEl.scrollHeight > available) {
                  size -= 0.5;
                  textEl.style.fontSize = `${size}px`;
                  textEl.style.lineHeight = "1.3";
                }
              },
            },
            m(".quote-text", config.joke!.text),
          ),
        )
      : null,
};

const MedicationCard: m.Component = {
  view: () =>
    config.medication?.length
      ? m(
          ".card.quote-card",
          m("span.card-corner-icon", m.trust(medicineIconForTheme)),
          m(
            ".quote-content",
            m(
              "ul.med-list",
              config.medication!.map((med) => {
                const scheduleStr = [
                  med.days?.length
                    ? med.days.map((d) => t(d) || d).join(", ")
                    : null,
                  med.dates?.length ? med.dates.join(", ") : null,
                ]
                  .filter(Boolean)
                  .join(" / ");
                return m(
                  "li.med-item",
                  med.time ? m("span.med-time", med.time) : null,
                  m(
                    "span.med-name",
                    med.name + (med.person ? ` (${med.person})` : ""),
                  ),
                  scheduleStr ? m("span.med-schedule", scheduleStr) : null,
                );
              }),
            ),
          ),
        )
      : null,
};

const AgendaDay: m.Component<{ day: DayAgenda }> = {
  view: ({ attrs: { day } }) => {
    // Use the translated day name for all days — no special "VANDAAG" label.
    const dayLabel = (
      t(day.dayName.toLowerCase()) || day.dayName
    ).toUpperCase();

    const w = (day as any).weather as WeatherData | undefined;
    const dayWeatherEl = w
      ? m(
          "span.day-weather",
          w.tempMin !== undefined && w.tempMax !== undefined
            ? `${w.tempMin}°/${w.tempMax}° `
            : `${w.temp}° `,
          m.trust(weatherIconForTheme(w.condition)),
        )
      : null;

    return m(
      ".agenda-day",
      m(
        ".day-header",
        m("span", dayLabel + (day.name ? ` — ${day.name}` : "")),
        dayWeatherEl,
      ),
      day.items.length > 0
        ? day.items.map((item) =>
            m(
              ".agenda-item",
              m(".time", item.time),
              m(
                ".title",
                translateTitle(item.title) +
                  (item.name ? ` (${item.name})` : ""),
              ),
            ),
          )
        : m(".no-agenda", labels.noEvents || t("noEvents")),
    );
  },
};

const AgendaPanel: m.Component = {
  view: () =>
    m(
      ".card.agenda-card",
      m(
        ".card-header",
        m("span", (config.title || labels.agenda || t("agenda")).toUpperCase()),
        m("span.card-header-date", formatHeaderDate(todayDate)),
      ),
      visibleAgenda.length > 0
        ? visibleAgenda.map((day) => m(AgendaDay, { day }))
        : m(".no-agenda", labels.noEvents || t("noEvents")),
    ),
};

const App: m.Component = {
  view: () =>
    m(
      ".container",
      m(".left-panel", m(AgendaPanel)),
      m(
        ".right-panel",
        m(WeatherCard),
        m(QuoteCard),
        m(JokeCard),
        m(MedicationCard),
      ),
    ),
};

m.mount(document.getElementById("app") || document.body, App);
