import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { createDeliveryClient } from '@kontent-ai/delivery-sdk';

// ---------------------------------------------------------------------------
// TYPE_URL_RESOLVERS
// Maps a Kontent.ai content type codename to the live URL path for that item.
// The resolver receives the item's own codename and returns a path string.
// Add or adjust entries to match your website's routing conventions.
// ---------------------------------------------------------------------------
const TYPE_URL_RESOLVERS = {
  article:    (codename) => `/articles/${codename.replace(/_/g, '-')}`,
  blog:       (codename) => `/blog/${codename.replace(/_/g, '-')}`,
  page:       (codename) => `/${codename.replace(/_/g, '-')}`,
};

/**
 * Resolve the URL slug for a content item.
 * Falls back to a plain /<codename> path when no resolver is registered.
 *
 * @param {string} codename  - The item's Kontent.ai codename.
 * @param {string} contentType - The item's content type codename.
 * @returns {string} Absolute path starting with "/".
 */
function resolveSlug(codename, contentType) {
  const resolver = TYPE_URL_RESOLVERS[contentType];
  return resolver ? resolver(codename) : `/${codename.replace(/_/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Build a GA4 Data client from the service-account key stored in env. */
function getAnalyticsClient() {
  const keyJson = process.env.GA_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GA_SERVICE_ACCOUNT_KEY is not set');
  const credentials = JSON.parse(keyJson);
  return new BetaAnalyticsDataClient({ credentials });
}

/** Build a Kontent.ai Delivery client from the environment ID stored in env. */
function getDeliveryClient() {
  const environmentId = process.env.VITE_ENVIRONMENT_ID;
  if (!environmentId) throw new Error('VITE_ENVIRONMENT_ID is not set');
  return createDeliveryClient({ environmentId });
}

// ---------------------------------------------------------------------------
// Helper: format raw seconds into "Xm Ys"
// ---------------------------------------------------------------------------
function formatSeconds(totalSeconds) {
  const s = Math.round(totalSeconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
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
  // Guard: required query param
  // ------------------------------------------------------------------
  const { codename } = req.query;
  if (!codename) {
    return res.status(400).json({ error: 'Missing required query parameter: codename' });
  }

  const propertyId = process.env.GA_PROPERTY_ID;
  if (!propertyId) {
    return res.status(500).json({ error: 'GA_PROPERTY_ID is not set on the server' });
  }

  // ------------------------------------------------------------------
  // Step 1 — Resolve the content item's URL slug from Kontent.ai
  // ------------------------------------------------------------------
  let slug = `/${codename.replace(/_/g, '-')}`;

  try {
    const deliveryClient = getDeliveryClient();
    const response = await deliveryClient.item(codename).toPromise();
    const contentType = response.data.item.system.type;
    slug = resolveSlug(codename, contentType);
  } catch {
    // Non-fatal: fall back to the derived slug if Kontent.ai is unreachable
    // or the item does not exist yet.
    console.warn(
      `Could not resolve slug from Kontent.ai for codename "${codename}". Using fallback: "${slug}"`
    );
  }

  // ------------------------------------------------------------------
  // Step 2 — Fire Historical + Realtime GA4 requests in parallel
  // ------------------------------------------------------------------
  const analyticsClient = getAnalyticsClient();

  // GA4 truncates User Property values at 36 characters.
  // Using BEGINS_WITH + a 36-char prefix guarantees a match even for
  // long slugs (e.g. /research/managing-pensions-for-the-future-2026).
  const slugPrefix = slug.substring(0, 36);

  const [historicalResult, realtimeResult] = await Promise.allSettled([

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
        { name: 'screenPageViews' },       // metric[0] — total page views
        { name: 'activeUsers' },           // metric[1] — unique users
        { name: 'userEngagementDuration' },// metric[2] — foreground time (seconds)
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'EXACT', value: slug },
        },
      },
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

  // ------------------------------------------------------------------
  // Step 3 — Aggregate Historical rows
  //
  // Because we query with three dimensions, the GA4 API returns a
  // separate row for every (pagePath, source, country) combination.
  // We sum across all rows to build grand totals, and separately
  // accumulate per-source and per-country view counts for the Top 3
  // lists.
  // ------------------------------------------------------------------
  let totalViews             = 0;
  let totalUsers             = 0;
  let totalEngagementSeconds = 0;
  const sourceCounts  = {};
  const countryCounts = {};

  if (historicalResult.status === 'fulfilled') {
    const [report] = historicalResult.value;
    const rows = report.rows ?? [];

    for (const row of rows) {
      // Dimension values (pagePath is dim[0] — we don't need its value here)
      const source  = row.dimensionValues?.[1]?.value ?? '(direct)';
      const country = row.dimensionValues?.[2]?.value ?? 'Unknown';

      // Metric values
      const views             = parseInt(row.metricValues?.[0]?.value ?? '0', 10);
      const users             = parseInt(row.metricValues?.[1]?.value ?? '0', 10);
      const engagementSeconds = parseFloat(row.metricValues?.[2]?.value ?? '0');

      // Grand totals
      totalViews             += views;
      totalUsers             += users;
      totalEngagementSeconds += engagementSeconds;

      // Per-dimension buckets (keyed by views for ranking)
      sourceCounts[source]   = (sourceCounts[source]   ?? 0) + views;
      countryCounts[country] = (countryCounts[country] ?? 0) + views;
    }
  } else {
    console.error('Historical GA4 request failed:', historicalResult.reason?.message);
  }

  // Average engagement time = Total Duration ÷ Total Users
  const avgEngagementSeconds = totalUsers > 0 ? totalEngagementSeconds / totalUsers : 0;

  const topSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([source, views]) => ({ source, views }));

  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([country, views]) => ({ country, views }));

  // ------------------------------------------------------------------
  // Step 4 — Aggregate Realtime rows
  // ------------------------------------------------------------------
  let activeUsers = 0;

  if (realtimeResult.status === 'fulfilled') {
    const [report] = realtimeResult.value;
    for (const row of report.rows ?? []) {
      activeUsers += parseInt(row.metricValues?.[0]?.value ?? '0', 10);
    }
  } else {
    console.error('Realtime GA4 request failed:', realtimeResult.reason?.message);
  }

  // ------------------------------------------------------------------
  // Step 5 — Build a deep-link back to GA4 for the editor
  // ------------------------------------------------------------------
  const gaLink =
    `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/explorer` +
    `?params=_u..nav%3Dmaui`;

  // ------------------------------------------------------------------
  // Step 6 — Return the response
  // ------------------------------------------------------------------
  return res.status(200).json({
    slug,
    historical: {
      views:                totalViews,
      users:                totalUsers,
      avgEngagementTime:    formatSeconds(avgEngagementSeconds),
      avgEngagementSeconds: Math.round(avgEngagementSeconds),
      topSources,
      topCountries,
    },
    realtime: {
      activeUsers,
    },
    gaLink,
  });
}
