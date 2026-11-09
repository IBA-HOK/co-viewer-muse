import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base: './' makes asset URLs relative so the built SPA works on a GitHub Pages
// project site (https://<user>.github.io/<repo>/) regardless of the repo name.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
