// Imported first by main.ts so config sees .env values (ESM evaluates imports in order).
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* env may come from the shell */ }
