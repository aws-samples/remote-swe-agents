'use client';

import { useEffect } from 'react';

/**
 * Last-resort error boundary. It replaces the ROOT layout, so no i18n
 * provider, theme provider, or global CSS is guaranteed here — keep it
 * dependency-free with inline styles and static copy.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error('Global error boundary caught:', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#f9fafb',
        }}
      >
        <div style={{ maxWidth: 420, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8, color: '#111827' }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: '#4b5563', marginBottom: 24 }}>
            An unexpected error occurred. Reloading usually fixes it.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 20px',
              fontSize: 14,
              borderRadius: 8,
              border: 'none',
              background: '#2563eb',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
