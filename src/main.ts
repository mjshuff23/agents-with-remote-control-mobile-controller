import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { applyAppGlobals } from './app-globals';
import { AppConfigService } from './config/app-config.service';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableCors({ origin: '*' }); // LAN-only dev tool; CONTROLLER_SECRET is the auth boundary until Phase 3 locks origin
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
