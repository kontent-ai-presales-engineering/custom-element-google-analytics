import React, { useEffect, useState } from 'react';
import { useItemInfo, useConfig, useVariantInfo } from '../customElement/CustomElementContext';

type DailyView = Readonly<{ date: string; views: number }>;
type SourceEntry = Readonly<{ source: string; userCount: number }>;
type CountryEntry = Readonly<{ country: string; userCount: number }>;

type ApiResponse = Readonly<{
  slug: string;
  historical: Readonly<{
    views: number;
    users: number;
    avgEngagementTime: number;
    dailyViews: ReadonlyArray<DailyView>;
    topSources: ReadonlyArray<SourceEntry>;
    topCountries: ReadonlyArray<CountryEntry>;
  }>;
  realtime: Readonly<{ activeUsers: number }>;
  gaLink: string;
}>;

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: ApiResponse };

const StatCard: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <div style={{
    background: '#ffffff',
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '24px 28px',
    flex: 1,
    minWidth: '160px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
  }}>
    <div style={{
      fontSize: '11px',
      fontWeight: 600,
      color: '#9ca3af',
      marginBottom: '10px',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
    }}>
      {label}
    </div>
    <div style={{ fontSize: '38px', fontWeight: 700, color: '#111827', lineHeight: 1 }}>
      {typeof value === 'number' ? value.toLocaleString() : value}
    </div>
  </div>
);

const Spinner: React.FC = () => (
  <>
    <style>{`@keyframes kai-spin { to { transform: rotate(360deg) } }`}</style>
    <div style={{
      width: 16,
      height: 16,
      border: '2px solid #d1d5db',
      borderTopColor: '#3b82f6',
      borderRadius: '50%',
      animation: 'kai-spin 0.75s linear infinite',
      flexShrink: 0,
    }} />
  </>
);

export const AnalyticsDashboard: React.FC = () => {
  const item = useItemInfo();
  const variant = useVariantInfo();
  const config = useConfig();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });

    const apiEndpoint = (config as Record<string, unknown>).apiEndpoint as string;
    const params = new URLSearchParams({ itemId: item.id, language: variant.codename });
    const url = `${apiEndpoint}?${params.toString()}`;

    fetch(url)
      .then(res => {
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}`);
        }
        return res.json() as Promise<ApiResponse>;
      })
      .then(data => setState({ status: 'success', data }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
        setState({ status: 'error', message });
      });
  }, [item.id, variant.codename, config]);

  return (
    <div style={{
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: '24px',
      background: '#f9fafb',
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: '17px', fontWeight: 700, color: '#111827' }}>
            GA4 Analytics
          </h1>
          <div style={{ fontSize: '12px', color: '#9ca3af' }}>
            <span style={{ color: '#6b7280' }}>{item.name}</span>
            <span style={{ margin: '0 6px' }}>·</span>
            <code style={{
              fontSize: '11px',
              background: '#f3f4f6',
              border: '1px solid #e5e7eb',
              padding: '1px 6px',
              borderRadius: '4px',
              color: '#374151',
            }}>
              {item.id}
            </code>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {state.status === 'loading' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '20px 0',
          color: '#6b7280',
          fontSize: '14px',
        }}>
          <Spinner />
          Loading analytics data…
        </div>
      )}

      {/* Error state */}
      {state.status === 'error' && (
        <div style={{
          padding: '14px 16px',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '8px',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#b91c1c', marginBottom: '4px' }}>
            Failed to load analytics
          </div>
          <div style={{ fontSize: '12px', color: '#ef4444' }}>
            {state.message}
          </div>
        </div>
      )}

      {/* Success state */}
      {state.status === 'success' && (
        <>
          {/* Stat cards */}
          <div style={{ display: 'flex', gap: '14px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <StatCard label="Page Views (30d)" value={state.data.historical.views} />
            <StatCard label="Users (30d)" value={state.data.historical.users} />
            <StatCard label="Live Users" value={state.data.realtime.activeUsers} />
            <StatCard
              label="Avg. Engagement"
              value={`${Math.round(state.data.historical.avgEngagementTime)}s`}
            />
          </div>

          {/* Resolved path + GA link */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 14px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: '8px',
            fontSize: '12px',
            color: '#1e40af',
            marginBottom: '16px',
          }}>
            <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" style={{ flexShrink: 0, opacity: 0.7 }}>
              <path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" />
            </svg>
            <span>Resolved path:</span>
            <strong style={{ color: '#1d4ed8' }}>{state.data.slug}</strong>
            <a
              href={state.data.gaLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 'auto', fontSize: '11px', color: '#2563eb', textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              Open in GA4 ↗
            </a>
          </div>

          {/* Top sources & countries */}
          {(state.data.historical.topSources.length > 0 || state.data.historical.topCountries.length > 0) && (
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
              {state.data.historical.topSources.length > 0 && (
                <div style={{ flex: 1, minWidth: '160px', background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Top Sources</div>
                  {state.data.historical.topSources.map(s => (
                    <div key={s.source} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#374151', marginBottom: '6px' }}>
                      <span>{s.source}</span>
                      <span style={{ fontWeight: 600 }}>{s.userCount.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
              {state.data.historical.topCountries.length > 0 && (
                <div style={{ flex: 1, minWidth: '160px', background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Top Countries</div>
                  {state.data.historical.topCountries.map(c => (
                    <div key={c.country} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#374151', marginBottom: '6px' }}>
                      <span>{c.country}</span>
                      <span style={{ fontWeight: 600 }}>{c.userCount.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
