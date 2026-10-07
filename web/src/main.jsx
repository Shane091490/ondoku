import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/figtree';
import '@fontsource-variable/literata';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './styles.css';
import App from './App.jsx';
import { initPwa } from './lib/pwa.js';

initPwa();
createRoot(document.getElementById('root')).render(<App />);
