import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ProblemDetailsFilter } from './common/errors/problem-details.filter';

/**
 * Apply global NestJS pipes and filters: validation (whitelist + forbid
 * non-whitelisted) and RFC 9457 problem-detail exception formatting.
 *
 * @param app - The NestJS application instance to configure.
 */
export function applyAppGlobals(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  }));
  app.useGlobalFilters(new ProblemDetailsFilter());
}
