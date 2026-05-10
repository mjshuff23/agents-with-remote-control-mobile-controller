import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ProblemDetailsFilter } from './common/errors/problem-details.filter';

export function applyAppGlobals(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  }));
  app.useGlobalFilters(new ProblemDetailsFilter());
}
