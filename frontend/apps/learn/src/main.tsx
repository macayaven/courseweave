import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { LearnApp } from './app';
import './styles';

createRoot(document.getElementById('root')!).render(<StrictMode><LearnApp /></StrictMode>);
