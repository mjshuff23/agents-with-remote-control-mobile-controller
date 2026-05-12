import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/** Global NestJS module that provides the Prisma database service. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService]
})
export class PrismaModule {}
