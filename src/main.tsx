import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// NOTE: StrictMode intentionally omitted. Its dev-only double effect invocation
// would initialise PeerJS twice and open duplicate DataChannels. Production builds
// are unaffected, but we keep behaviour identical dev/prod for this P2P app.
createRoot(document.getElementById('root')!).render(<App />);

// Guarded to production only so the Vite dev server is never intercepted.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

void StrictMode;
