import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/figtree/latin-400.css';
import '@fontsource/figtree/latin-500.css';
import '@fontsource/figtree/latin-600.css';
import '@fontsource/inter-tight/latin-300.css';
import '@fontsource/inter-tight/latin-400.css';
import '@fontsource/inter-tight/latin-800.css';
import '@fontsource/inter-tight/latin-900-italic.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import './styles.css';
import { App } from './App';
import { initTheme } from './theme';

initTheme();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
