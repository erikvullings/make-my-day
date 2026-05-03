import type { Quote, Joke, QuoteFetcherConfig, JokeFetcherConfig } from './types.js';

// ── Quote APIs ────────────────────────────────────────────────────────────────

const QUOTE_APIS = {
  zenquotes: 'https://zenquotes.io/api/random',
  quotable: 'https://api.quotable.io/random?tags=inspirational',
};

// ── Joke APIs ─────────────────────────────────────────────────────────────────

// JokeAPI v2 language codes (subset of languages it supports)
const JOKEAPI_LANG_MAP: Record<string, string> = {
  en: 'en', de: 'de', cs: 'cs', pt: 'pt', es: 'es', fr: 'fr',
};

// APIs that work for English (and some other languages via JokeAPI)
type JokeApiName = 'jokeapi' | 'official-joke-api' | 'chuck-norris' | 'dadjoke';

const GENERAL_JOKE_APIS: JokeApiName[] = [
  'jokeapi',
  'official-joke-api',
  'chuck-norris',
  'dadjoke',
];

// ── Joke fetchers per API ─────────────────────────────────────────────────────

async function fetchFromJokeAPI(language: string): Promise<string | null> {
  const lang = JOKEAPI_LANG_MAP[language] ?? 'en';
  const url = `https://v2.jokeapi.dev/joke/Any?lang=${lang}&blacklistFlags=nsfw,racist,sexist,explicit`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    if (data.type === 'twopart') return `${data.setup} — ${data.delivery}`;
    return (data.joke as string) || null;
  } catch {
    return null;
  }
}

async function fetchFromOfficialJokeAPI(): Promise<string | null> {
  try {
    const res = await fetch('https://official-joke-api.appspot.com/random_joke');
    if (!res.ok) return null;
    const data = await res.json();
    const setup: string = data.setup || '';
    const punchline: string = data.punchline || '';
    return setup && punchline ? `${setup} — ${punchline}` : null;
  } catch {
    return null;
  }
}

async function fetchFromChuckNorris(): Promise<string | null> {
  try {
    const res = await fetch('https://api.chucknorris.io/jokes/random');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.value as string) || null;
  } catch {
    return null;
  }
}

async function fetchFromDadJoke(): Promise<string | null> {
  try {
    const res = await fetch('https://icanhazdadjoke.com/', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.joke as string) || null;
  } catch {
    return null;
  }
}

async function fetchFromAPI(api: JokeApiName, language: string): Promise<string | null> {
  switch (api) {
    case 'jokeapi':           return fetchFromJokeAPI(language);
    case 'official-joke-api': return fetchFromOfficialJokeAPI();
    case 'chuck-norris':      return fetchFromChuckNorris();
    case 'dadjoke':           return fetchFromDadJoke();
  }
}

// ── Public exports ────────────────────────────────────────────────────────────

export async function fetchQuote(config?: QuoteFetcherConfig): Promise<Quote> {
  if (!config?.enabled) {
    if (config?.text) return { text: config.text, author: config.author };
    return { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' };
  }

  const apiName = config.api || 'zenquotes';
  const apiUrl = QUOTE_APIS[apiName as keyof typeof QUOTE_APIS];

  if (!apiUrl) {
    return { text: config.text || 'Quote unavailable', author: config.author };
  }

  try {
    const response = await fetch(apiUrl);
    if (response.ok) {
      const data = await response.json();
      const quote: Quote = apiName === 'zenquotes'
        ? { text: data[0]?.q || '', author: data[0]?.a || '' }
        : { text: data?.content || '', author: data?.author || '' };
      if (quote.text) return quote;
    }
  } catch {
    // fall through
  }

  if (config.text) return { text: config.text, author: config.author };
  return { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' };
}

export async function fetchJoke(config?: JokeFetcherConfig, language = 'en'): Promise<Joke> {
  if (!config?.enabled) {
    if (config?.text) return { text: config.text };
    return { text: 'Why do programmers prefer dark mode? Because light attracts bugs.' };
  }

  // Build a priority list: preferred API first, then the rest shuffled.
  // This ensures variety even when an explicit API is configured, since many
  // APIs (especially jokeapi for non-English languages) have very small pools.
  const preferred = config.api && config.api !== 'static' ? config.api : null;
  const others = [...GENERAL_JOKE_APIS]
    .filter((a) => a !== preferred)
    .sort(() => Math.random() - 0.5);
  const order: JokeApiName[] = preferred ? [preferred, ...others] : others;
  for (const api of order) {
    const joke = await fetchFromAPI(api, language);
    if (joke) return { text: joke };
  }

  if (config.text) return { text: config.text };
  return { text: 'Why do programmers prefer dark mode? Because light attracts bugs.' };
}
