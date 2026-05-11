import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { DEFAULT_DATABASE_URL } from '../config/env.validation';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
    if (!dbUrl.startsWith('file:')) {
      throw new Error(
        `DATABASE_URL must use the file: scheme for SQLite (got: ${dbUrl.split(':')[0]}:)`,
      );
    }
    // better-sqlite3 expects a filesystem path, not a file: URI
    super({ adapter: new PrismaBetterSqlite3({ url: dbUrl.slice(5) }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
