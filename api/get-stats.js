import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { createDeliveryClient } from '@kontent-ai/delivery-sdk';

// ---------------------------------------------------------------------------
// URL mapping: Kontent.ai codename → production URL slug
// Add every content type codename pattern you want to resolve here.
// ---------------------------------------------------------------------------
const SLUG_MAP = {
  // Articles
  article: (codename) => `/research/${codename.replace(/_/g, '-')}`,
  // Pages
  page: (codename) => `/${codename.replace(/_/g, '-')}`,
  // Services
  service: (codename) => `/services/${codename.replace(/_/g, '-')}`,
  // Blog posts
  blog_post: (codename) => `/blog/${codename.replace(/_/g, '-')}`,
  // Case studies
  case_study: (codename) => `/case-studies/${codename.replace(/_/g, '-')}`,
};

// Fallback: use the codename as the path directly
function resolveSlug(codename, contentType) {
  const resolver = SLUG_MAP[contentType];
  return resolver ? resolver(codename) : `/${codename.replace(/_/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Google Analytics client (initialised lazily from env)
// ---------------------------------------------------------------------------
function getAnalyticsClient() {
  const keyJson = process.env.GA_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GA_SERVICE_ACCOUNT_KEY is not set');

  const credentials = JSON.parse(keyJson);
  return new BetaAnalyticsDataClient({ credentials });
}

// ---------------------------------------------------------------------------
// Kontent.ai Delivery client
// ---------------------------------------------------------------------------
function getDeliveryClient() {
  const environmentId = process.env.VITE_ENVIRONMENT_ID;
  if (!environmentId) throw new Error('VITE_ENVIRONMENT_ID is not set');
  return createDeliveryClient({ environmentId });
}

// ---------------------------------------------------------------------------
// Helper: format seconds → "Xm Ys"
// ---------------------------------------------------------------------------
function formatSeconds(totalSeconds) {
  const s = Math.round(totalSeconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS headers so the Kontent.ai iframe can call this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { codename } = req.query;
  if (!codename) {
    return res.status(400).json({ error: 'Missing required query parameter: codename' });
  }

  const propertyId = process.env.GA_PROPERTY_ID;
  if (!propertyId) {
    return res.status(500).json({ error: 'GA_PROPERTY_ID is not set on the server' });
  }

  // ------------------------------------------------------------------
  // 1. Resolve the URL slug from Kontent.ai
  // ------------------------------------------------------------------
  let slug = `/${codename.replace(/_/g, '-')}`;
  try {
    const deliveryClient = getDeliveryClient();
    const response = await deliveryClient.item(codename).toPromise();
    const item = response.data.item;
    const contentType = item.system.type;
    slug = resolveSlug(codename, contentType);
  } catch {
    // If Kontent.ai lookup fails, fall back to the derived slug — not fatal
    console.warn(`Could not resolve slug from Kontent.ai for codename "${codename}". Using fallback.`);
  }

  // ------------------------------------------------------------------
  // 2. Fire Historical + Realtime GA4 requests in parallel
  // ------------------------------------------------------------------
  const analyticsClient = getAnalyticsClient();

  // GA4 truncates User Property values at 36 characters.
  // Use BEGINS_WITH so long slugs still match.
  const slugPrefix = slug.substring(0, 36);

  const [historicalResult, realtimeResult] = await Promise.allSettled([
    // --- Historical: last 30 days ---
    analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [
        { name: 'sessionSource' },
        { name: 'country' },
        { name: 'customEvent:kontent_codename' },
      ],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'totalUsers' },
        { name: 'userEngagementDuration' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'customEvent:kontent_codename',
          stringFilter: { matchType: 'EXACT', value: codename },
        },
      },
    }),

    // --- Realtime: last 30 minutes ---
    analyticsClient.runRealtimeReport({
      property: `properties/${propertyId}`,
      dimensions: [{ name: 'customUser:current_page_path' }],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'customUser:current_page_path',
          stringFilter: { matchType: 'BEGINS_WITH', value: slugPrefix },
        },
      },
    }),
  ]);

  // ------------------------------------------------------------------
  // 3. Aggregate Historical rows
  // ------------------------------------------------------------------
  let totalViews = 0;
  let totalUsers = 0;
  let totalEngagementSeconds = 0;
  const sourceCounts = {};
  const countryCounts = {};

  if (historicalResult.status === 'fulfilled') {
    const [report] = historicalResult.value;
    const rows = report.rows ?? [];

    for (const row of rows) {
      const source = row.dimensionValues?.[0]?.value ?? '(direct)';
      const country = row.dimensionValues?.[1]?.value ?? 'Unknown';
      const views = parseInt(row.metricValues?.[0]?.value ?? '0', 10);
      const users = parseInt(row.metricValues?.[1]?.value ?? '0', 10);
      const engagementSeconds = parseFloat(row.metricValues?.[2]?.value ?? '0');

      totalViews += views;
      totalUsers += users;
      totalEngagementSeconds += engagementSeconds;

      sourceCounts[source] = (sourceCounts[source] ?? 0) + views;
      countryCounts[country] = (countryCounts[country] ?? 0) + views;
    }
  } else {
    console.error('Historical GA4 request failed:', historicalResult.reason);
  }

  const avgEngagementSeconds = totalViews > 0 ? totalEngagementSeconds / totalViews : 0;

  const topSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([source, views]) => ({ source, views }));

  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([country, views]) => ({ country, views }));

  // ------------------------------------------------------------------
  // 4. Aggregate Realtime rows
  // ------------------------------------------------------------------
  let activeUsers = 0;

  if (realtimeResult.status === 'fulfilled') {
    const [report] = realtimeResult.value;
    const rows = report.rows ?? [];
    for (const row of rows) {
      activeUsers += parseInt(row.metricValues?.[0]?.value ?? '0', 10);
    }
  } else {
    console.error('Realtime GA4 request failed:', realtimeResult.reason);
  }

  // ------------------------------------------------------------------
  // 5. Build GA4 deep-link for convenience
  // ------------------------------------------------------------------
  const gaLink = `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/explorer?params=_u..nav%3Dmaui`;

  // ------------------------------------------------------------------
  // 6. Return response
  // ------------------------------------------------------------------
  return res.status(200).json({
    slug,
    historical: {
      views: totalViews,
      users: totalUsers,
      avgEngagementTime: formatSeconds(avgEngagementSeconds),
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
