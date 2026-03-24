export type Config = Readonly<{
  apiEndpoint: string;
}>;

export const isConfig = (value: Readonly<Record<string, unknown>> | null): value is Config =>
  value !== null &&
  typeof value.apiEndpoint === 'string' &&
  value.apiEndpoint.length > 0;
