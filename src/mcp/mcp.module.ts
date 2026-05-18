import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { McpRegistryService } from './registry/mcp-registry.service';
import { McpTransportFactory } from './transport/mcp-transport.factory';

/** Phase 5 MCP boundary — registry and transport spine. Permissions, execution, and audit arrive in later tickets. */
@Module({
  imports: [AppConfigModule],
  providers: [McpRegistryService, McpTransportFactory],
  exports: [McpRegistryService, McpTransportFactory]
})
export class McpModule {}
