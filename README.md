[![MIT License][license-shield]][license-url]
[![Discord][discord-shield]][discord-url]

# GA4 Hybrid Dashboard for Kontent.ai

A "Mission Control" style sidebar dashboard for Kontent.ai editors. It shows **real-time and historical Google Analytics 4 data** for the individual content item currently open — without the editor ever leaving the CMS.

---

## Features

- **Live Pulse** — Active users on the specific page right now (last 30 mins), with an animated indicator.
- **Engagement Metrics** — Total views, unique users, and average foreground read time over 30 days.
- **Daily Breakdown** — Per-day page view chart for the last 30 days.
- **Traffic Insights** — Top 3 referral sources and top 3 countries.
- **Smart Filtering** — Handles long URL slugs by using a `BEGINS_WITH` match to bypass the GA4 36-character User Property limit.
- **Direct GA4 Link** — Pre-filtered deep-link opens the exact page report in Google Analytics.
- **ID-based lookup** — Resolves analytics data via the content item's UUID, making lookups independent of codename changes.

---

## Architecture

```
Browser (Kontent.ai sidebar)
        │  CustomElement.init → reads item ID + language variant
        │  fetch ?itemId=<uuid>&language=<codename>
        ▼
api/get-stats.js  (Vercel Serverless Function)
        │  1. Fetch item from Delivery API by system.id
        │  2. Resolve URL slug via TYPE_URL_RESOLVERS
        │  3. Promise.allSettled([historical, daily, realtime])
        │     ├── GA4 Reporting API  (30 days, aggregated)
        │     ├── GA4 Reporting API  (30 days, per-day breakdown)
        │     └── GA4 Realtime API   (30 mins, BEGINS_WITH filter)
        │  4. Aggregate rows → totals, topSources, topCountries, dailyViews
        └── JSON response
```

---

## Alternative: Custom App (Dialog Mode)

This integration is implemented as a **Custom Element** embedded in the content item sidebar. If you prefer a **full-screen dialog** experience instead — for example to show larger charts or additional reports — the same concept is available as a Custom App:

**[kontent-ai-presales-engineering/custom-app-dialog-google-analytics](https://github.com/kontent-ai-presales-engineering/custom-app-dialog-google-analytics)**

Custom Apps open as a modal dialog triggered from the Kontent.ai toolbar, giving you more screen real estate while reusing the same GA4 backend API.

---

## Setup

### 1. Google Analytics 4 — Register Custom Dimensions

In your GA4 property go to **Admin → Custom Definitions** and create a custom user-scoped dimension:

| Name | Scope | Parameter / Property |
|---|---|---|
| Current Page Path | **User** | `current_page_path` |

### 2. Website Tracking

Send the value from your website's `gtag` configuration so the Realtime filter works:

```js
// Set once per page load — populates the Realtime filter
gtag('set', 'user_properties', {
  current_page_path: window.location.pathname,
});
```

### 3. Deploy the Backend (Vercel)

1. Push this repo to GitHub and import it in [Vercel](https://vercel.com).
2. Set the following **Environment Variables** in your Vercel project settings:

| Variable | Description |
|---|---|
| `GA_PROPERTY_ID` | Your 9-digit GA4 Property ID |
| `GA_SERVICE_ACCOUNT_KEY` | The full JSON content of your Google Service Account key file (as a single string) |
| `VITE_ENVIRONMENT_ID` | Your Kontent.ai Project/Environment ID |

> **Service Account permissions:** The service account must have the **Viewer** role on your GA4 property (Admin → Property Access Management).

Copy `.env.example` to `.env` for local development.

### 4. Configure Kontent.ai

1. Go to **Collections → Custom Elements** (or add it inside a Content Type).
2. Create a new Custom Element pointing to your hosted `index.html`.
3. Set the **JSON Parameters**:

```json
{
  "apiEndpoint": "https://your-vercel-app.vercel.app/api/get-stats"
}
```

4. Add the Custom Element to the desired Content Type sidebar.

---

## URL Resolution

The `api/get-stats.js` file contains a `TYPE_URL_RESOLVERS` object that maps Kontent.ai content type codenames to URL patterns. Each resolver receives the **full content item** so it can read element values directly:

```js
const TYPE_URL_RESOLVERS = {
  article:   (item) => `/articles/${item.elements.url_slug?.value}`,
  blog_post: (item) => `/blog/${item.elements.url_slug?.value}`,
  page:      (item) => `/${item.elements.url?.value}`,
  service:   (item) => `/services/${item.elements.url_slug?.value}`,
  microsite: (item) => `/microsite/${item.elements.url?.value}`,
  person:    (item) => `/our-team/${item.system.codename}`,
};
```

Add your own content types here. Items with an unrecognised type return a `422` response so missing resolvers are surfaced clearly rather than silently falling back.

---

## Technical Note: The 36-Character Limit

Google Analytics truncates **User Property** values (used for Real-time data) at **36 characters**. For a slug like `/research/managing-pensions-for-the-future-2026` that's a problem.

This integration works around it by:

1. Extracting only the first 36 characters of the slug: `slug.substring(0, 36)`.
2. Using a `BEGINS_WITH` match type in the Realtime API filter instead of `EXACT`.

This ensures the dashboard reliably finds active users even on pages with long URL slugs.

---

## API Reference

`GET {apiEndpoint}?itemId={uuid}&language={language_codename}`

| Parameter | Required | Description |
|---|---|---|
| `itemId` | Yes | The content item's UUID (e.g. `3fa85f64-5717-4562-b3fc-2c963f66afa6`) |
| `language` | No | Language codename (defaults to `default`) |

### Response

```json
{
  "slug": "/research/my-article",
  "historical": {
    "views": 1234,
    "users": 890,
    "avgEngagementTime": 134,
    "dailyViews": [
      { "date": "2025-03-01", "views": 42 },
      { "date": "2025-03-02", "views": 67 }
    ],
    "topSources": [
      { "source": "google", "userCount": 560 },
      { "source": "(direct)", "userCount": 210 },
      { "source": "linkedin.com", "userCount": 88 }
    ],
    "topCountries": [
      { "country": "United States", "userCount": 400 },
      { "country": "United Kingdom", "userCount": 180 },
      { "country": "Germany", "userCount": 95 }
    ]
  },
  "realtime": {
    "activeUsers": 3
  },
  "gaLink": "https://analytics.google.com/analytics/web/#/p12345/..."
}
```

---

## Local Development

```bash
# Install dependencies
npm ci

# Start Vite dev server (React frontend)
npm run dev

# Test the serverless function locally with Vercel CLI
npx vercel dev
```

---

## License

Distributed under the MIT License. See [LICENSE.md](./LICENSE.md) for more information.


[license-shield]: https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge
[license-url]: ./LICENSE.md
[discord-shield]: https://img.shields.io/discord/821885171984891914?color=%237289DA&label=Kontent.ai%20Discord&logo=discord&style=for-the-badge
[discord-url]: https://discord.com/invite/SKCxwPtevJ
