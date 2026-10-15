import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Variables already set in the environment take precedence over .env.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read directly instead of via env(), which throws when unset and would
    // break `prisma generate` on a clean checkout without a .env file.
    url: process.env.DATABASE_URL,
  },
});
