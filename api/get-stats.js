import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { createDeliveryClient } from '@kontent-ai/delivery-sdk';

// ---------------------------------------------------------------------------
// TYPE_URL_RESOLVERS
// Maps a Kontent.ai content type codename to the live URL path for that item.
// Each resolver receives the full content item and returns a path string.
// Add or adjust entries to match your website's routing conventions.
// ---------------------------------------------------------------------------
const TYPE_URL_RESOLVERS = {
  article:    (item) => `/articles/${item.elements.url_slug?.value}`,
  blog_post:  (item) => `/blog/${item.elements.url_slug?.value}`,
  page:       (item) => `/${item.elements.url?.value}`,
  service:    (item) => `/services/${item.elements.url_slug?.value}`,
  microsite:  (item) => `/microsite/${item.elements.url?.value}`,
  person:     (item) => `/our-team/${item.system.codename}`,
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Build a GA4 Data client from the service-account key stored in env. */
function getAnalyticsClient() {
  const keyJson = process.env.GA_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GA_SERVICE_ACCOUNT_KEY is not set');
  const credentials = JSON.parse(keyJson);
  credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  return new BetaAnalyticsDataClient({ credentials });
}

/** Build a Kontent.ai Delivery client from the environment ID stored in env. */
function getDeliveryClient() {
  const environmentId = process.env.VITE_ENVIRONMENT_ID;
  if (!environmentId) throw new Error('VITE_ENVIRONMENT_ID is not set');
  return createDeliveryClient({ environmentId });
}

// ---------------------------------------------------------------------------
// Main Vercel handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS — required so the Kontent.ai editor iframe can call this endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ------------------------------------------------------------------
  // Guard: required query params
  // ------------------------------------------------------------------
  const { itemId, language = 'default' } = req.query;

  if (!itemId || !UUID_REGEX.test(itemId)) {
    return res.status(400).json({ error: 'Missing or invalid itemId (expected a UUID).' });
  }

  const propertyId = process.env.GA_PROPERTY_ID;
  if (!propertyId) {
    return res.status(500).json({ error: 'GA_PROPERTY_ID is not set on the server.' });
  }

  // ------------------------------------------------------------------
  // Step 1 — Fetch the content item by ID and resolve its URL slug
  // ------------------------------------------------------------------
  let item;
  try {
    const deliveryClient = getDeliveryClient();
    const response = await deliveryClient
      .items()
      .equalsFilter('system.id', itemId)
      .languageParameter(language)
      .toPromise();

    item = response.data.items[0];
    if (!item) throw new Error('Not found');
  } catch {
    return res.status(404).json({ error: `Content item '${itemId}' not found.` });
  }

  const urlResolver = TYPE_URL_RESOLVERS[item.system.type];
  if (!urlResolver) {
    return res.status(422).json({ error: `No URL resolver registered for content type '${item.system.type}'.` });
  }

  const slug = urlResolver(item);

  // ------------------------------------------------------------------
  // Step 2 — Fire Historical + Daily + Realtime GA4 requests in parallel
  // ------------------------------------------------------------------
  const analyticsClient = getAnalyticsClient();

  // GA4 truncates User Property values at 36 characters.
  // Using BEGINS_WITH + a 36-char prefix guarantees a match even for
  // long slugs (e.g. /research/managing-pensions-for-the-future-2026).
  const slugPrefix = slug.substring(0, 36);

  const [historicalResult, dailyResult, realtimeResult] = await Promise.allSettled([

    // ── Historical: last 30 days ──────────────────────────────────────
    // Three dimensions mean the API returns one row per unique
    // (pagePath × sessionSource × country) combination.
    // We must loop and aggregate all rows into totals ourselves.
    analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [
        { name: 'pagePath' },       // dim[0] — used as the filter field
        { name: 'sessionSource' },  // dim[1] — traffic source breakdown
        { name: 'country' },        // dim[2] — country breakdown
      ],
      metrics: [
        { name: 'screenPageViews' },        // metric[0] — total page views
        { name: 'activeUsers' },            // metric[1] — unique users
        { name: 'userEngagementDuration' }, // metric[2] — foreground time (seconds)
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'EXACT', value: slug },
        },
      },
    }),

    // ── Daily breakdown: last 30 days ─────────────────────────────────
    analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [
        { name: 'date' },
        { name: 'pagePath' },
      ],
      metrics: [{ name: 'screenPageViews' }],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'EXACT', value: slug },
        },
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),

    // ── Realtime: last 30 minutes ─────────────────────────────────────
    // Dimension customUser:current_page_path is a GA4 User Property that
    // your website must populate: gtag('set','user_properties',{current_page_path: …})
    analyticsClient.runRealtimeReport({
      property: `properties/${propertyId}`,
      dimensions: [{ name: 'customUser:current_page_path' }],
      metrics:   [{ name: 'activeUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'customUser:current_page_path',
          stringFilter: { matchType: 'BEGINS_WITH', value: slugPrefix },
        },
      },
    }),

  ]);

  if (historicalResult.status === 'rejected') {
    console.error('Historical GA4 request failed:', historicalResult.reason?.message);
    return res.status(500).json({ error: 'Historical fetch failed.' });
  }

  // ------------------------------------------------------------------
  // Step 3 — Aggregate Historical rows
  //
  // Because we query with three dimensions, the GA4 API returns a
  // separate row for every (pagePath, source, country) combination.
  // We sum across all rows to build grand totals, and separately
  // accumulate per-source and per-country user counts for the Top 3
  // lists.
  // ------------------------------------------------------------------
  let totalViews             = 0;
  let totalUsers             = 0;
  let totalEngagementSeconds = 0;
  const sourceCounts  = {};
  const countryCounts = {};

  const [hReport] = historicalResult.value;
  for (const row of hReport.rows ?? []) {
    const source  = row.dimensionValues?.[1]?.value ?? '(direct)';
    const country = row.dimensionValues?.[2]?.value ?? 'Unknown';

    const views             = parseInt(row.metricValues?.[0]?.value ?? '0', 10);
    const users             = parseInt(row.metricValues?.[1]?.value ?? '0', 10);
    const engagementSeconds = parseFloat(row.metricValues?.[2]?.value ?? '0');

    totalViews             += views;
    totalUsers             += users;
    totalEngagementSeconds += engagementSeconds;

    sourceCounts[source]   = (sourceCounts[source]   ?? 0) + users;
    countryCounts[country] = (countryCounts[country] ?? 0) + users;
  }

  const avgEngagementSeconds = totalUsers > 0 ? totalEngagementSeconds / totalUsers : 0;

  const topSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([source, userCount]) => ({ source, userCount }));

  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([country, userCount]) => ({ country, userCount }));

  // ------------------------------------------------------------------
  // Step 4 — Process Daily rows
  // ------------------------------------------------------------------
  const dailyViews = [];

  if (dailyResult.status === 'fulfilled') {
    const [dReport] = dailyResult.value;
    for (const row of dReport.rows ?? []) {
      const raw = row.dimensionValues?.[0]?.value ?? ''; // "YYYYMMDD"
      const date = raw.length === 8
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        : raw;
      dailyViews.push({ date, views: parseInt(row.metricValues?.[0]?.value ?? '0', 10) });
    }
  } else {
    console.warn('Daily GA4 request failed:', dailyResult.reason?.message);
  }

  // ------------------------------------------------------------------
  // Step 5 — Aggregate Realtime rows
  // ------------------------------------------------------------------
  let activeUsers = 0;

  if (realtimeResult.status === 'fulfilled') {
    const [rReport] = realtimeResult.value;
    for (const row of rReport.rows ?? []) {
      activeUsers += parseInt(row.metricValues?.[0]?.value ?? '0', 10);
    }
  } else {
    console.warn('Realtime GA4 request failed:', realtimeResult.reason?.message);
  }

  // ------------------------------------------------------------------
  // Step 6 — Build a deep-link back to GA4 for the editor
  // ------------------------------------------------------------------
  const filterJson = JSON.stringify([{ field: 'pagePath', expression: slug }]);
  const gaParams = `_u..nav=default&_r.explorerCard..filter=${filterJson}`;
  const gaLink =
    `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/explorer` +
    `?params=${encodeURIComponent(gaParams)}`;

  // ------------------------------------------------------------------
  // Step 7 — Return the response
  // ------------------------------------------------------------------
  return res.status(200).json({
    slug,
    historical: {
      views:             totalViews,
      users:             totalUsers,
      avgEngagementTime: Math.round(avgEngagementSeconds),
      dailyViews,
      topSources,
      topCountries,
    },
    realtime: {
      activeUsers,
    },
    gaLink,
  });
}
