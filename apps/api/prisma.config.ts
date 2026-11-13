import { defineConfig } from 'prisma/config';

try { process.loadEnvFile('.env'); } catch { /* env may come from the shell */ }

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node --experimental-strip-types prisma/seed.ts' },
  datasource: { url: process.env.DATABASE_URL! },
});
