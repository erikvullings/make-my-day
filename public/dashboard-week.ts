import m from "mithril";
import { getTranslator } from "./translations.js";
import { getWeatherIcon, getWeatherIconColor } from "./weather-icons.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

interface AgendaItem {
  time: string;
  title: string;
  name?: string;
  location?: string;
}

interface WeatherData {
  temp: number;
  tempMin?: number;
  tempMax?: number;
  condition: string;
  icon: string;
}

interface DayAgenda {
  date: string;
  dayName: string;
  name?: string;
  weather?: WeatherData;
  items: AgendaItem[];
}

interface Labels {
  agenda?: string;
  week?: string;
  noEvents?: string;
}

type FontSize = "small" | "medium" | "large" | "xlarge";

interface FontMetrics {
  header: number;
  day: number;
  item: number;
  weather: number;
  quote: number;
}

interface DashboardConfig {
  title?: string;
  language?: string;
  fontSize?: FontSize;
  theme?: "color" | "bw";
  antiAliasing?: boolean;
  labels?: Labels;
  agenda?: DayAgenda[];
  cacheTime?: string;
}

// ── Font sizes (mirrors dashboard.ts) ────────────────────────────────────────

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
    title: "Week",
    language: "nl",
    theme: "bw",
    agenda: [
      {
        date: new Date().toISOString().split("T")[0],
        dayName: "Monday",
        items: [],
      },
    ],
  };
}

// ── Runtime setup ─────────────────────────────────────────────────────────────

const config = getConfigFromURL();
const language = config.language || "nl";
const t = getTranslator(language);
const labels: Labels = config.labels || {
  agenda: t("agenda"),
  week: t("week") || "Week",
  noEvents: t("noEvents"),
};

const theme = config.theme || "bw";
const weatherIconForTheme =
  theme === "color" ? getWeatherIconColor : getWeatherIcon;
const fontSize: FontSize = (config.fontSize as FontSize) || "large";
const fm = FONT_SIZES[fontSize] || FONT_SIZES.large;
const root = document.documentElement;
root.style.setProperty("--fs-header", `${fm.header}px`);
root.style.setProperty("--fs-day", `${fm.day}px`);
root.style.setProperty("--fs-item", `${fm.item}px`);
root.style.setProperty("--fs-weather", `${fm.weather}px`);
root.setAttribute("data-theme", theme);
if (config.antiAliasing) root.setAttribute("data-aa", "true");

// ── Week calculation ──────────────────────────────────────────────────────────

/**
 * Returns the Monday that should anchor page 2 (the week overview).
 *
 * Rule: if Sunday is already visible on page 1 — which happens whenever today
 * is Friday (5), Saturday (6), or Sunday (0) — page 2 starts from the NEXT
 * Monday so the two pages are complementary rather than overlapping.
 * On all other days page 2 shows the current calendar week (Mon–Sun).
 */
function getWeekStartMonday(): Date {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const d = new Date(today);
  if (dow === 0 || dow >= 5) {
    // Sunday is visible on page 1 → next Monday
    const daysToNextMonday = dow === 0 ? 1 : 8 - dow;
    d.setDate(today.getDate() + daysToNextMonday);
  } else {
    // Regular weekday → this week's Monday
    d.setDate(today.getDate() - (dow - 1));
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

interface WeekDay {
  date: string;
  dow: number; // JS getDay() value: 0=Sun … 6=Sat
  label: string; // e.g. "MA 30 MRT"
  isToday: boolean;
  weather?: WeatherData;
  items: AgendaItem[];
}

/**
 * Builds the 7-day week array (Mon–Sun) starting from the computed Monday.
 * Events are looked up from config.agenda by ISO date string.
 */
function buildWeekDays(): WeekDay[] {
  const monday = getWeekStartMonday();
  const agendaByDate = new Map<string, DayAgenda>();
  for (const day of config.agenda || []) {
    agendaByDate.set(day.date, day);
  }

  const todayStr = new Date().toISOString().split("T")[0];
  const days: WeekDay[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    d.setHours(12, 0, 0, 0); // noon avoids DST edge cases
    const dateStr = d.toISOString().split("T")[0];

    // Use the browser's Intl API for locale-aware day and month abbreviations.
    // Strip trailing periods that some locales append (e.g. Dutch "mrt.", "di.").
    const dayAbbr = d
      .toLocaleDateString(language, { weekday: "short" })
      .replace(/\./g, "")
      .trim()
      .toUpperCase();
    const monthAbbr = d
      .toLocaleDateString(language, { month: "short" })
      .replace(/\./g, "")
      .trim()
      .toUpperCase();
    const label = `${dayAbbr} ${d.getDate()} ${monthAbbr}`;

    const agenda = agendaByDate.get(dateStr);
    days.push({
      date: dateStr,
      dow: d.getDay(),
      label,
      isToday: dateStr === todayStr,
      weather: agenda?.weather,
      items: agenda?.items || [],
    });
  }

  return days;
}

const weekDays = buildWeekDays();
// Left column: Mon–Thu (first 4), Right column: Fri–Sun (last 3, only when non-empty)
const leftDays = weekDays.slice(0, 4);
const rightDays = weekDays.slice(4);
const hasRightEvents = rightDays.some((d) => d.items.length > 0);

// ── Components ────────────────────────────────────────────────────────────────

const WeekDayView: m.Component<{ day: WeekDay }> = {
  view: ({ attrs: { day } }) =>
    m(
      ".week-day",
      { class: day.isToday ? "today" : "" },
      m(
        ".week-day-header",
        m("span", day.label),
        day.weather
          ? m(
              "span.week-day-weather",
              m.trust(weatherIconForTheme(day.weather.condition)),
              day.weather.tempMin !== undefined &&
                day.weather.tempMax !== undefined
                ? ` ${day.weather.tempMin}°/${day.weather.tempMax}°`
                : ` ${day.weather.temp}°`,
            )
          : null,
      ),
      day.items.length > 0
        ? day.items.map((item) =>
            m(
              ".week-item",
              m(".week-time", item.time),
              m(
                ".week-title",
                item.title + (item.name ? ` (${item.name})` : ""),
              ),
            ),
          )
        : m(".week-no-events", labels.noEvents || t("noEvents")),
    ),
};

const WeekColumn: m.Component<{ days: WeekDay[] }> = {
  view: ({ attrs: { days } }) =>
    m(
      ".week-column",
      days.map((day) => m(WeekDayView, { day })),
    ),
};

function formatCacheTime(iso: string, lang: string): string {
  const d = new Date(iso);
  return d.toLocaleString(lang, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const WeekPanel: m.Component = {
  view: () =>
    m(
      ".card.week-card",
      m(".card-header", config.title || labels.week || "Week"),
      m(
        ".week-container",
        m(WeekColumn, { days: leftDays }),
        hasRightEvents ? m(WeekColumn, { days: rightDays }) : null,
      ),
      config.cacheTime
        ? m(".cache-time", formatCacheTime(config.cacheTime, language))
        : null,
    ),
};

const App: m.Component = {
  view: () => m(".container-full", m(WeekPanel)),
};

m.mount(document.getElementById("app")!, App);
