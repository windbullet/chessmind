import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDebugBridge } from './debugBridge';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './styles/tokens.css';
import './styles/app.css';
import './styles/board.css';
import './styles/editor.css';
import './styles/panels.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

// No-op in a production build: the bridge exposes the live stores (and with
// them the API keys), so it must never be reachable outside `npm run dev`.
installDebugBridge();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
