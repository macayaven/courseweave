import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/author/',
  build: { outDir: '../../../src/courseweave/static/author', emptyOutDir: true },
});
