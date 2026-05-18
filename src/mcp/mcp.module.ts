import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { AuditLogModule } from '../features/audit/audit-log.module';
import { McpRegistryService } from './registry/mcp-registry.service';
import { McpTransportFactory } from './transport/mcp-transport.factory';
import { McpPermissionService } from './permissions/mcp-permission.service';

/** Phase 5 MCP boundary — registry, transport, and permission ladder. */
@Module({
  imports: [AppConfigModule, AuditLogModule],
  providers: [McpRegistryService, McpTransportFactory, McpPermissionService],
  exports: [McpRegistryService, McpTransportFactory, McpPermissionService]
})
export class McpModule {}
