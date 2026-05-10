import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { applyAppGlobals } from './app-globals';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  applyAppGlobals(app);
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  await app.listen(config.port, config.host);
}

void bootstrap();
