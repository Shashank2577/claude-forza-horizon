import { defineConfig } from 'vite';

// GitHub Pages hosts project sites at /<repo>/, so built assets must be
// referenced under that prefix. Dev keeps `/` so localhost URLs don't change;
// only the production *build* gets the repo-prefixed base.
const isBuild = process.argv.includes('build');

export default defineConfig({
  server: { port: 5173, strictPort: true, host: true },
  base: isBuild ? '/claude-forza-horizon/' : '/',
  build: { target: 'es2022', sourcemap: true },
});
