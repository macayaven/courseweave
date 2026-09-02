import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthorApp } from './app';
createRoot(document.getElementById('root')!).render(<StrictMode><AuthorApp /></StrictMode>);
