export { fetchWeather } from './weather.js';
export { fetchEvents, setupOAuth } from './google-calendar.js';
export { scrapeAgenda } from './website-scraper.js';
export { fetchCarenAgenda, fetchCarenAgendaHeadless } from './caren.js';

export type {
  AgendaItem,
  DayAgenda,
  WeatherData,
  Medication,
  Labels,
  WeatherFetcherConfig,
  GoogleCalendarFetcherConfig,
  WebsiteScraperFetcherConfig,
  CarenFetcherConfig,
  FetchersConfig,
  DashboardConfig,
  CalendarEvent,
  WeatherResult
} from './types.js';
