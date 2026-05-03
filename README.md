# Make My Day

A server that generates your agenda, weather, daily quotes or jokes as dashboard images for [Seeed reTerminal E1001](https://www.seeedstudio.com/reTerminal-E1001-p-5736.html) (7.5" B&W e-ink), [E1002](https://www.seeedstudio.com/reTerminal-E1002-p-6044.html) (7.3" 6-color e-ink) displays, and browsers. Dashboards are configured via YAML files with random, unguessable IDs (the same model as WeTransfer links) and are updated every couple of hours. The browser version can also be installed as Progressive Web App (PWA) on your phone, table or desktop.

<img width="1083" height="1486" alt="image" src="https://github.com/user-attachments/assets/dc127395-340b-4bbe-8058-8b0daeafd4c1" />

## What it does

Create a YAML config → the server renders a dashboard image → your e-ink panel fetches it periodically.

The dashboard can show:

- **Agenda** from Caren.nl (Dutch care planner), Google Calendar, or any website via headless scraper
- **Live weather** from Open-Meteo (free, no API key needed)
- **Daily quotes or jokes**
- **Medication reminders** for multiple people

## Supported devices

| Device               | Display                          | Theme                                                   | Description                                      |
| -------------------- | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| **reTerminal E1001** | 7.5", 800×480, B&W               | `bw` or `grayscale4`                                    | Budget-friendly, great for text-heavy dashboards |
| **reTerminal E1002** | 7.3", 800×480, 6-color Spectra 6 | `color` (dithered to black/white/red/green/blue/yellow) | Full-color dashboard with richer visuals         |

## Quick Start (local)

### With Bun (fastest)

```bash
# 1. Install dependencies
bun install

# 2. Install Playwright's Chromium browser (used for screenshot rendering)
bunx playwright install chromium

# 3. Start the server
bun start
```

### With Node.js (recommended for production)

```bash
npm install
npx playwright install chromium
npx tsx server.ts
```

Node.js is recommended over Bun for long-running production deployments. The Dockerfile uses Node.js at runtime to avoid zombie child processes (Bun's process model doesn't propagate SIGCHLD correctly, causing renderer zombies).

The server runs at `http://localhost:7000`. Create `configs/example.yaml` and access it at `http://localhost:7000/example`.

## Flashing your e-ink panel

This section walks you through setting up ESPHome and flashing your reTerminal. If you've never used ESPHome before, follow the steps in order.

### Step 1: Install ESPHome

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt  # or: pip install esphome
```

### Step 2: Connect your panel

Connect your reTerminal to your computer via USB cable. On macOS the device appears as `/dev/cu.usbmodable*` or `/dev/cu.wch*`. On Linux it's usually `/dev/ttyUSB0` or `/dev/ttyACM0`.

### Step 3: Choose your config

Copy the ESPHome config for your device:

```bash
# For B&W panel (E1001):
cp reterminal-e1001.yaml my-panel.yaml

# For 6-color panel (E1002):
cp reterminal-e1002.yaml my-panel.yaml
```

### Step 4: Configure your dashboard URL

Edit your `my-panel.yaml` and change the `dashboard_base_url` in the **secrets section** (see below). You'll need to know your server's IP address and your dashboard ID.

**Example URLs:**

- Local: `http://192.168.1.100:7000/my-dashboard`
- Public (Cloudflare): `https://dashboard.example.com/my-dashboard`

### Step 5: Set up secrets

The ESPHome configs use `!secret` references to keep credentials out of the main YAML. You have two options:

#### Option A: Use a secrets file (recommended)

1. Copy the example secrets file: `cp .esphome-secrets.example.yaml secrets.yaml`
2. Edit `secrets.yaml` and fill in your WiFi credentials, dashboard URL, and generate your API key:

   ```bash
   esphome generate encryption-key my-panel.yaml
   ```

3. Keep `secrets.yaml` private — never commit it.

#### Option B: Inline values (simpler for beginners)

Replace every `!secret secret_name` in the YAML with the actual value directly. E.g.:

```yaml
substitutions:
  base_url: "http://192.168.1.100:7000/my-dashboard"
```

This is perfectly fine if you're just getting started or if you use ESPHome's web dashboard for OTA updates.

### Step 6: Flash the device

```bash
esphome run my-panel.yaml --device /dev/cu.wch*
```

(Omit `--device` to list available ports.)

### Step 7: Connect to WiFi

After flashing, the panel will connect to your WiFi. Find its IP address in your router's device list or check the ESPHome logs.

## Creating your first dashboard

### Basic config

Create a file `configs/my-dashboard.yaml`, where the filename is also used as URL, so if your server is on the Internet, make sure to make the URL impossible to guess:

```yaml
title: "My Day"
theme: color        # 'bw' for B&W (E1001), 'color' for 6-color (E1002)
fontSize: large     # small | medium | large (default) | xlarge

agenda:
  - date: "2026-05-01"
    dayName: "Friday"
    items:
      - time: "09:00"
        title: "Team Standup"
      - time: "14:00"
        title: "Design Review"
        location: "Conference Room"

weather:
  temp: 18
  tempUnit: "C"
  condition: "Partly Cloudy"
  icon: "⛅"
  humidity: 65
  wind: 12

medication:
  - time: "08:00"
    person: "Emma"
    name: "Vitamin D"
  - time: "20:00"
    name: "Magnesium"
```

### Accessing your dashboard

| URL                                        | Description                              |
| ------------------------------------------ | ---------------------------------------- |
| `http://localhost:7000/my-dashboard`       | Responsive HTML (phone-friendly preview) |
| `http://localhost:7000/my-dashboard.png`   | E-ink image (page 1)                     |
| `http://localhost:7000/my-dashboard-2.png` | E-ink image (page 2, week view)          |
| `http://localhost:7000/my-dashboard.html`  | Fixed 800×480 HTML (e-ink preview)       |

### Complete per-person example

Here's a complete config combining **Caren.nl agenda**, **live weather**, **medication reminders**, and a **daily quote**:

```yaml
title: "Emma — Weekoverzicht"
language: nl
theme: color

fetchers:
  caren:
    enabled: true
    usernameEnvVar: CAREN_EMMA_USERNAME
    passwordEnvVar: CAREN_EMMA_PASSWORD
    totpSecretEnvVar: CAREN_EMMA_TOTP_SECRET
    personId: 12345
    days: 7
  weather:
    enabled: true
    latitude: 52.3676
    longitude: 4.9041
    locationName: "Amsterdam"
  quote:
    enabled: true
    api: zenquotes

medication:
  - time: "08:00"
    person: "Emma"
    name: "Vitamin D"
    days: [monday, wednesday, friday]
  - time: "22:00"
    person: "Emma"
    name: "Melatonin"
```

> **Multiple people?** Create a separate YAML config file for each person (e.g. `emma.yaml`, `liam.yaml`) with their own `caren` fetcher and env vars. Use the same dashboard ID in your ESPHome config to always fetch the same person's page.

## Fetchers (automatic data)

Instead of manually writing agenda items, you can enable fetchers that pull data automatically.

### Weather

Fetches from [Open-Meteo](https://open-meteo.com/) (free, no API key):

```yaml
fetchers:
  weather:
    enabled: true
    latitude: 52.3676
    longitude: 4.9041
    locationName: "Amsterdam"
```

Weather is also automatically attached to each day in your agenda.

### Caren.nl (Dutch care planner)

The server can fetch care plans from [Caren.nl](https://caren.nl) (Dutch care planner). Set up credentials in your `.env` file (see `.env.example`):

1. Log into Caren.nl → **Settings → Security → "Extra beveiliging bij het inloggen"**
2. Enable two-factor auth with an authenticator app (Google Authenticator, Authy, etc.)
3. Copy the Base32 secret (e.g. `ABCDEFGHIJKLMLNOPQRSTUVWXYX`)
4. Uncomment and fill in the CAREN env vars in `.env`

The `personId` is a numeric Caren.nl user ID. You can find it by visiting `https://caren.nl` while logged in — it appears in the URL path `/people/<id>/`.

The server handles login, TOTP code generation, and session caching automatically. If a session expires, it re-logs in transparently.

### Google Calendar

```yaml
fetchers:
  googleCalendar:
    enabled: true
    credentialsFile: "./credentials.json"  # Google OAuth service account file
    calendarId: "primary"
    days: 7
```

Generate `credentials.json` via the [Google Cloud Console](https://console.cloud.google.com/) (OAuth service account with Calendar API enabled).

### Quote & Joke

```yaml
# Daily rotating quote from a public API
fetchers:
  quote:
    enabled: true
    api: zenquotes   # zenquotes | quotable | static

# Or use a static quote
quote:
  text: "The only way to do great work is to love what you do."
  author: "Steve Jobs"

# Daily rotating joke
fetchers:
  joke:
    enabled: true
    api: jokeapi     # jokeapi | official-joke-api | chuck-norris | dadjoke | static

# Or use a static joke
joke:
  text: "Why did the developer go broke? Because he used up all his cache."
```

### Website Scraper

For any web-based agenda (e.g., a school portal or hospital scheduling system):

```yaml
fetchers:
  websiteScraper:
    enabled: true
    loginUrl: "https://school.example.com/login"
    targetUrl: "https://school.example.com/agenda"
    username: "parent123"
    password: "secret"
```

The scraper uses a headless browser to log in and extract events. Each fetcher runs independently with a 45-second timeout and retries up to 3 times with exponential backoff.

## Multi-page support

Your dashboard has two pages:

- **Page 1** (`/id.png`): Agenda (as many days as fit) + weather + quote/joke + medication
- **Page 2** (`/id-2.png`): Week overview with days split in two columns

On the panel, press the secondary button to cycle between pages. The ESPHome config uses GPIO4 for "next" and GPIO5 for "previous" (E1001) or GPIO2 for "previous" (E1002).

## Hosting options

### Option 1: Run locally (easiest for LAN-only panels)

Just run the server on any computer that stays on — a laptop, Raspberry Pi, or desktop.

```bash
npm install && npx tsx server.ts    # Node.js (recommended for production)
# or
bun install && bun start            # Bun (faster dev, avoid for long-running)
```

For LAN-only panels, skip external hosting entirely.

Update your ESPHome config to use your local IP:

```yaml
base_url: "http://192.168.1.100:7000/my-dashboard"
```

### Option 2: Docker on a home server

Build and run with Docker Compose:

```bash
docker compose up -d --build
```

The image uses `tini` as PID 1 for proper process reaping and binds to `0.0.0.0:7000` by default.

Dockerfile is provided — no registry needed. The server reads from `./configs` (bind-mount it) and `.env` for credentials.

### Option 3: Public URL via reverse proxy

If your e-ink panel needs to fetch from outside your LAN (e.g., a panel at a relative's house), expose the server via:

- **[Nginx](https://nginx.org/) / [Caddy](https://caddyserver.com/)** — a reverse proxy with a domain and TLS. Example Nginx:

  ```nginx
  server {
      listen 443 ssl;
      server_name dashboard.example.com;
      location / {
          proxy_pass http://192.168.1.100:7000;
          proxy_set_header Host $host;
      }
  }
  ```

- **[Cosmos Server](https://cosmos-cloud.io/)** — set up a proxy route with automatic TLS (Let's Encrypt). Set the source to `dashboard.yourdomain.com`, target to `http://localhost:7000`, and mark as **public** (safe because dashboard IDs are random opaque strings).
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-tunnels/)** — `cloudflared tunnel --url http://localhost:7000`
- **[Tailscale Funnel](https://tailscale.com/kb/1242/tailscale-funnel)** — `tailscale funnel 7000`

> **Why public is safe**: Dashboard IDs are random opaque strings — effectively unguessable bearer tokens. There is no sensitive data behind a guessable URL. No authentication, no user accounts, no personal data in URLs.

## Environment Variables

See `.env.example` for all options. Key variables:

| Variable                         | Default                    | Description                                                      |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `PORT`                           | `7000`                     | Server port                                                      |
| `CONFIG_DIR`                     | `./configs`                | Directory for YAML config files                                  |
| `REFRESH_INTERVAL`               | `50 5,8,11,14,17,20 * * *` | Cron schedule for auto-refresh                                   |
| `CACHE_TTL_MINUTES`              | `240`                      | How long fetched data stays cached (4 hours)                     |
| `SHARED_BROWSER_MAX_RENDERS`     | `200`                      | Restart Chromium after this many renders (prevents memory leaks) |
| `SHARED_BROWSER_MAX_AGE_MINUTES` | `180`                      | Restart Chromium after this age                                  |

## Language support

The dashboard supports 13 languages. Set `language` in your YAML config:

| Code | Language   | Code | Language |
| ---- | ---------- | ---- | -------- |
| `en` | English    | `de` | German   |
| `nl` | Dutch      | `fr` | French   |
| `ro` | Romanian   | `es` | Spanish  |
| `it` | Italian    | `pl` | Polish   |
| `hu` | Hungarian  | `sv` | Swedish  |
| `pt` | Portuguese | `cs` | Czech    |
| `el` | Greek      |      |          |

Day names, labels, and weather terms are translated at display time.

## File structure

```bash
make-my-day/
├── server.ts              # Main server (Bun HTTP + Playwright Chromium)
├── browser.ts             # Chromium launcher (system browser detection)
├── package.json           # Dependencies
├── Dockerfile             # Container image
├── docker-compose.yml     # Docker Compose service
├── .env.example           # Environment variable template
├── .esphome-secrets.example.yaml  # ESPHome secrets template
├── configs/               # Dashboard YAML configs
│   ├── example-color.yaml # Color theme example
│   ├── example-bw.yaml    # B&W theme example
│   └── example-week.yaml  # Week overview example
├── fetchers/              # Data sources (weather, Caren, Google Calendar, quote, joke, scraper)
├── public/                # Frontend assets (HTML, CSS, JS, icons)
├── reterminal-e1001.yaml  # ESPHome config for B&W panel (multi-page)
├── reterminal-e1002.yaml  # ESPHome config for 6-color panel (multi-page)
└── rtc_fix.h             # RTC fix for E1002 deep sleep stability
```

## How it works

1. You create a YAML config in `configs/`
2. The server reads the config, runs enabled fetchers (weather, calendar, etc.), and caches the enriched data
3. When `/:id.png` is requested, Playwright renders the dashboard in headless Chromium and takes a screenshot
4. The screenshot is dithered to the target palette (B&W, 4-level grayscale, or 6-color Spectra 6) using Floyd-Steinberg dithering
5. Your ESPHome panel fetches the PNG on a schedule (default: every 3 hours or when a button is pressed)

A shared Chromium instance is reused across renders and recycled after 200 renders or 3 hours to prevent memory leaks.

## Troubleshooting

| Problem                              | Solution                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Panel won't connect to WiFi          | Verify WiFi credentials, ensure 2.4 GHz (ESP32 doesn't support 5 GHz)                 |
| Image not loading                    | `curl http://your-server:7000/YOUR_ID.png` to test the server                         |
| Display showing garbled image        | Normal on first boot — press the refresh button                                       |
| Battery draining too fast            | Increase `sleep_duration` in ESPHome config; reduce `update_interval`                 |
| Caren fetcher failing                | Check TOTP secret is correct (16-32 char Base32); check env var names match the YAML  |
| Server crashes after running a while | The shared browser recycles automatically. If not, check `SHARED_BROWSER_MAX_RENDERS` |
