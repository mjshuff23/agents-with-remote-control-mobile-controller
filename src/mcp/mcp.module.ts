import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { AuditLogModule } from '../features/audit/audit-log.module';
import { EventsModule } from '../events/events.module';
import { McpRegistryService } from './registry/mcp-registry.service';
import { McpTransportFactory } from './transport/mcp-transport.factory';
import { McpPermissionService } from './permissions/mcp-permission.service';
import { McpToolCallService } from './execution/mcp-tool-call.service';

/** Phase 5 MCP boundary — registry, transport, permission ladder, and approval pipeline. */
@Module({
  imports: [AppConfigModule, AuditLogModule, EventsModule],
  providers: [McpRegistryService, McpTransportFactory, McpPermissionService, McpToolCallService],
  exports: [McpRegistryService, McpTransportFactory, McpPermissionService, McpToolCallService]
})
export class McpModule {}
