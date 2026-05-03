import { OAuth2Client } from 'google-auth-library';
import { google, calendar_v3 } from 'googleapis';
import fs from 'fs';
import path from 'path';
import type { GoogleCalendarFetcherConfig, CalendarEvent } from './types.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const TOKEN_PATH = '.make-my-day/google-calendar-token.json';
const CREDENTIALS_PATH = '.make-my-day/credentials.json';

function getCredentialsPath(configuredPath?: string): string {
  if (configuredPath) {
    return configuredPath;
  }
  return path.join(process.cwd(), CREDENTIALS_PATH);
}

function getTokenPath(): string {
  return path.join(process.cwd(), TOKEN_PATH);
}

async function loadSavedCredentials(): Promise<OAuth2Client | null> {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
  const oAuth2Client = new OAuth2Client(
    token.client_id,
    token.client_secret,
    token.redirect_uri
  );
  
  oAuth2Client.setCredentials(token);
  
  if (token.expiry_date && token.expiry_date < Date.now()) {
    return new Promise((resolve, reject) => {
      oAuth2Client.refreshAccessToken((err, tokens) => {
        if (err) {
          reject(err);
          return;
        }
        if (!tokens) {
          reject(new Error('No tokens returned from refresh'));
          return;
        }
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens));
        resolve(oAuth2Client);
      });
    });
  }
  
  return oAuth2Client;
}

async function loadClientCredentials(credentialsPath: string): Promise<{ client_id: string; client_secret: string; redirect_uris: string[] } | null> {
  if (!fs.existsSync(credentialsPath)) {
    return null;
  }
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
  return credentials.installed || credentials.web;
}

async function getAuthenticatedClient(credentialsPath: string): Promise<OAuth2Client> {
  let oAuth2Client = await loadSavedCredentials();
  
  if (oAuth2Client) {
    return oAuth2Client;
  }
  
  const credentials = await loadClientCredentials(credentialsPath);
  if (!credentials) {
    throw new Error(`No credentials found at ${credentialsPath}. Run 'bun run fetchers/google-calendar.ts setup' first.`);
  }
  
  const { client_id, client_secret, redirect_uris } = credentials;
  oAuth2Client = new OAuth2Client(client_id, client_secret, redirect_uris[0]);
  
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  
  console.log('\nAuthorize this app by visiting this URL:');
  console.log(authUrl);
  console.log('\n');
  
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const code = await new Promise<string>((resolve) => {
    rl.question('Enter the authorization code: ', (code) => {
      rl.close();
      resolve(code);
    });
  });
  
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  
  const dir = path.dirname(getTokenPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getTokenPath(), JSON.stringify(tokens));
  
  console.log('Token stored to', getTokenPath());
  
  return oAuth2Client;
}

export async function setupOAuth(credentialsFile?: string): Promise<void> {
  const credPath = credentialsFile 
    ? path.join(process.cwd(), credentialsFile)
    : path.join(process.cwd(), CREDENTIALS_PATH);
  
  if (!fs.existsSync(credPath)) {
    console.log('\n=== Google Calendar OAuth Setup ===\n');
    console.log('You need to create OAuth credentials:');
    console.log('1. Go to https://console.cloud.google.com');
    console.log('2. Create a new project');
    console.log('3. Enable Google Calendar API');
    console.log('4. Go to Credentials > Create Credentials > OAuth client ID');
    console.log('5. Choose "Desktop app" as application type');
    console.log('6. Download the credentials.json file');
    console.log(`7. Save it to: ${credPath}`);
    console.log('\nThen run this command again.\n');
    throw new Error(`Credentials file not found at ${credPath}`);
  }
  
  await getAuthenticatedClient(credPath);
  console.log('\nOAuth setup complete! You can now use Google Calendar fetcher.\n');
}

export async function fetchEvents(config: GoogleCalendarFetcherConfig): Promise<CalendarEvent[]> {
  const credentialsPath = getCredentialsPath(config.credentialsFile);
  const auth = await getAuthenticatedClient(credentialsPath);
  
  const calendar = google.calendar({ version: 'v3', auth });
  
  const now = new Date();
  const days = config.days ?? 7;
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + days);
  
  const response = await calendar.events.list({
    calendarId: config.calendarId || 'primary',
    timeMin: now.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: (config.maxEventsPerDay ?? 10) * days
  });
  
  const events = response.data.items || [];
  const result: CalendarEvent[] = [];
  
  for (const event of events) {
    if (!event.start) continue;
    
    const start = event.start.dateTime || event.start.date;
    if (!start) continue;
    
    const eventDate = new Date(start);
    const dateStr = eventDate.toISOString().split('T')[0];
    const timeStr = event.start.dateTime 
      ? eventDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      : '00:00';
    
    result.push({
      date: dateStr,
      dayName: eventDate.toLocaleDateString('en-US', { weekday: 'long' }),
      time: timeStr,
      title: event.summary || 'Busy',
      location: event.location || undefined
    });
  }
  
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === 'setup') {
    const credIndex = args.indexOf('--credentials-file');
    const credFile = credIndex !== -1 ? args[credIndex + 1] : undefined;
    setupOAuth(credFile).catch(console.error);
  } else {
    console.log('Usage:');
    console.log('  bun run fetchers/google-calendar.ts setup --credentials-file <path>');
    console.log('\nFirst, get credentials from Google Cloud Console:');
    console.log('  https://console.cloud.google.com > APIs > Calendar > Credentials');
  }
}
