import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { applyAppGlobals } from './app-globals';
import { AppConfigService } from './config/app-config.service';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  applyAppGlobals(app);
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  await app.listen(config.port, config.host);
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof Error) {
    logger.error('Application bootstrap failed', error.stack);
  } else {
    logger.error(`Application bootstrap failed: ${String(error)}`);
  }
  process.exit(1);
});
