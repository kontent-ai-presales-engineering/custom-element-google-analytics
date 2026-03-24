export type AnalyticsData = Readonly<{
  pageViews: number;
  uniqueVisitors: number;
  bounceRate: number;
  avgTimeOnPage: number; // in seconds
  lastUpdated: string; // ISO date string
  pageViewsHistory: ReadonlyArray<{ date: string; views: number }>;
}>;

export type Value = Readonly<{
  analyticsData: AnalyticsData | null;
}>;

export const parseValue = (input: string | null): Value | null | "invalidValue" => {
  if (input === null) {
    return null;
  }

  try {
    const parsedValue = JSON.parse(input);

    return isValidValue(parsedValue) ? parsedValue : "invalidValue";
  }
  catch (e) {
    return "invalidValue";
  }
};

const isValidValue = (obj: Readonly<Record<string, unknown>>) =>
  "analyticsData" in obj;
