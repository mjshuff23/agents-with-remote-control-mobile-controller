import { Controller, Get } from '@nestjs/common';

/** Simple health check endpoint returning `{ status: 'ok' }`. */
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
