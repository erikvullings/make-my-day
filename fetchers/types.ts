export interface AgendaItem {
  time: string;
  title: string;
  name?: string;
  location?: string;
}

export interface DayAgenda {
  date: string;
  dayName: string;
  name?: string;
  weather?: WeatherData;
  items: AgendaItem[];
}

export interface WeatherData {
  date?: string;
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

export interface Medication {
  name: string;
  person?: string;
  time?: string;
  days?: string[];
  dates?: number[];
}

export interface Quote {
  text: string;
  author?: string;
}

export interface Joke {
  text: string;
}

export interface Labels {
  language?: string;
  agenda?: string;
  weather?: string;
  medication?: string;
  noEvents?: string;
  humidity?: string;
  wind?: string;
  week?: string;
  today?: string;
  tomorrow?: string;
}

export interface WeatherFetcherConfig {
  enabled: boolean;
  latitude?: number;
  longitude?: number;
  locationName?: string;
}

export interface GoogleCalendarFetcherConfig {
  enabled: boolean;
  credentialsFile?: string;
  calendarId?: string;
  days?: number;
  maxEventsPerDay?: number;
}

export interface WebsiteScraperFetcherConfig {
  enabled: boolean;
  loginUrl?: string;
  targetUrl?: string;
  username?: string;
  password?: string;
}

export interface CarenFetcherConfig {
  enabled: boolean;
  loginUrl?: string;
  agendaUrl?: string;
  usernameEnvVar?: string;
  passwordEnvVar?: string;
  phoneNumberEnvVar?: string;
  totpSecretEnvVar?: string;
  /** Caren numeric person ID (e.g. 12345). Avoids auto-detection on the home page. */
  personId?: string | number;
  days?: number;
}

export interface QuoteFetcherConfig {
  enabled?: boolean;
  api?: 'zenquotes' | 'quotable' | 'static';
  text?: string;
  author?: string;
  language?: string;
}

export interface JokeFetcherConfig {
  enabled?: boolean;
  api?: 'jokeapi' | 'official-joke-api' | 'chuck-norris' | 'dadjoke' | 'static';
  text?: string;
}

export interface FetchersConfig {
  weather?: WeatherFetcherConfig;
  googleCalendar?: GoogleCalendarFetcherConfig;
  websiteScraper?: WebsiteScraperFetcherConfig;
  caren?: CarenFetcherConfig;
  quote?: QuoteFetcherConfig;
  joke?: JokeFetcherConfig;
}

export interface DashboardConfig {
  title?: string;
  language?: string;
  fontSize?: string;
  labels?: Labels;
  agenda?: DayAgenda[];
  weather?: WeatherData;
  medication?: Medication[];
  quote?: Quote | QuoteFetcherConfig;
  joke?: Joke | JokeFetcherConfig;
  theme?: 'color' | 'bw';
  width?: number;
  height?: number;
  fetchers?: FetchersConfig;
  responsive?: boolean;
  /** Enable anti-aliasing for devices that support it (e.g. e1001). Default: false. */
  antiAliasing?: boolean;
  cacheTime?: string;
}

export interface CalendarEvent {
  date: string;
  dayName: string;
  time: string;
  title: string;
  location?: string;
}

export interface WeatherResult {
  current: WeatherData;
  daily: WeatherData[];
}
