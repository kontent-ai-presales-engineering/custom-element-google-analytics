[![MIT License][license-shield]][license-url]
[![Discord][discord-shield]][discord-url]

# GA4 Hybrid Dashboard for Kontent.ai

A "Mission Control" style sidebar dashboard for Kontent.ai editors. It shows **real-time and historical Google Analytics 4 data** for the individual content item currently open — without the editor ever leaving the CMS.

---

## Features

- **Live Pulse** — Active users on the specific page right now (last 30 mins), with an animated indicator.
- **Engagement Metrics** — Total views, unique users, and average foreground read time over 30 days.
- **Traffic Insights** — Top 3 referral sources and top 3 countries with inline bar charts.
- **Smart Filtering** — Handles long URL slugs by using a `BEGINS_WITH` match to bypass the GA4 36-character User Property limit.
- **Zero-config UI** — Pure HTML/CSS/JS with no build step; drop `public/index.html` anywhere and it works.

---

## Architecture

```
Browser (Kontent.ai sidebar)
        │  CustomElement.init → reads item codename
        │  fetch ?codename=my_article
        ▼
api/get-stats.js  (Vercel Serverless Function)
        │  1. Resolve slug from Kontent.ai Delivery API
        │  2. Promise.allSettled([historical, realtime])
        │     ├── GA4 Reporting API  (30 days)
        │     └── GA4 Realtime API   (30 mins, BEGINS_WITH filter)
        │  3. Aggregate rows → totals, topSources, topCountries
        └── JSON response
```

---

## Setup

### 1. Google Analytics 4 — Register Custom Dimensions

In your GA4 property go to **Admin → Custom Definitions** and create two custom dimensions:

| Name | Scope | Parameter / Property |
|---|---|---|
| Current Page Path | **User** | `current_page_path` |
| Kontent Codename | **Event** | `kontent_codename` |

### 2. Website Tracking

Send the values from your website's `gtag` configuration:

```js
// Set once per page load — populates the Realtime filter
gtag('set', 'user_properties', {
  current_page_path: window.location.pathname,
});

// Send with every page_view — populates the Historical filter
gtag('event', 'page_view', {
  kontent_codename: 'your_item_codename',
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
2. Create a new Custom Element pointing to your hosted `public/index.html`.
3. Set the **JSON Parameters**:

```json
{
  "apiEndpoint": "https://your-vercel-app.vercel.app/api/get-stats"
}
```

4. Add the Custom Element to the desired Content Type sidebar.

---

## URL Resolution

The `api/get-stats.js` file contains a `SLUG_MAP` object that maps Kontent.ai content type codenames to URL patterns:

```js
const SLUG_MAP = {
  article:    (codename) => `/research/${codename.replace(/_/g, '-')}`,
  page:       (codename) => `/${codename.replace(/_/g, '-')}`,
  service:    (codename) => `/services/${codename.replace(/_/g, '-')}`,
  blog_post:  (codename) => `/blog/${codename.replace(/_/g, '-')}`,
  case_study: (codename) => `/case-studies/${codename.replace(/_/g, '-')}`,
};
```

Add your own content types here. If a type is not found, the codename is used as a fallback path.

---

## Technical Note: The 36-Character Limit

Google Analytics truncates **User Property** values (used for Real-time data) at **36 characters**. For a slug like `/research/managing-pensions-for-the-future-2026` that's a problem.

This integration works around it by:

1. Extracting only the first 36 characters of the slug: `slug.substring(0, 36)`.
2. Using a `BEGINS_WITH` match type in the Realtime API filter instead of `EXACT`.

This ensures the dashboard reliably finds active users even on pages with long URL slugs.

---

## API Response Shape

`GET {apiEndpoint}?codename={item_codename}`

```json
{
  "slug": "/research/my-article",
  "historical": {
    "views": 1234,
    "users": 890,
    "avgEngagementTime": "2m 14s",
    "avgEngagementSeconds": 134,
    "topSources": [
      { "source": "google", "views": 560 },
      { "source": "(direct)", "views": 210 },
      { "source": "linkedin.com", "views": 88 }
    ],
    "topCountries": [
      { "country": "United States", "views": 400 },
      { "country": "United Kingdom", "views": 180 },
      { "country": "Germany", "views": 95 }
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
