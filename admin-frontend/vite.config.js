/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Admin console build. Separada del portal de usuarios para deployar en
// admin.tecnyapp.com con su propio bundle, su propio CSP, y sin exponer
// código super-admin al frontend público.
//
// Port 5174 elegido a propósito para no chocar con el portal (5173) cuando
// Lucas levanta los dos en paralelo en local.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
  },
  preview: {
    port: 5174,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.js'],
    globals: true,
    css: false,
  },
});
