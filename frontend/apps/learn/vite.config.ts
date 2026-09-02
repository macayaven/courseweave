import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/learn/',
  plugins: [react()],
  build: {
    outDir: '../../../src/courseweave/static/learn',
    emptyOutDir: true
  }
});
