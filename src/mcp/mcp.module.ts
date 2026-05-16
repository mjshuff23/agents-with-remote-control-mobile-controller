import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { McpRegistryService } from './registry/mcp-registry.service';

/** Phase 5 MCP boundary — registry spine for TSH-112. Transport, permissions, audit added in later tickets. */
@Module({
  imports: [AppConfigModule],
  providers: [McpRegistryService],
  exports: [McpRegistryService]
})
export class McpModule {}
