import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { AuditLogModule } from '../features/audit/audit-log.module';
import { EventsModule } from '../events/events.module';
import { McpRegistryService } from './registry/mcp-registry.service';
import { McpTransportFactory } from './transport/mcp-transport.factory';
import { McpPermissionService } from './permissions/mcp-permission.service';
import { McpAuditService } from './audit/mcp-audit.service';
import { McpToolCallService } from './execution/mcp-tool-call.service';

/** Phase 5 MCP boundary — registry, transport, permission ladder, approval pipeline, and structured audit. */
@Module({
  imports: [AppConfigModule, AuditLogModule, EventsModule],
  providers: [McpRegistryService, McpTransportFactory, McpPermissionService, McpAuditService, McpToolCallService],
  exports: [McpRegistryService, McpTransportFactory, McpPermissionService, McpAuditService, McpToolCallService]
})
export class McpModule {}
