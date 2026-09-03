import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthorApp } from './app';
import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><AuthorApp /></StrictMode>);
