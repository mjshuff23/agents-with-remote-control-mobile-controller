import { defineConfig } from 'prisma/config';
import { DEFAULT_DATABASE_URL } from './src/config/env.validation';

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
});
