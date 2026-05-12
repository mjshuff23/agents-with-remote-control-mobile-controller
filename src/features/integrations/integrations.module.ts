import { Module } from '@nestjs/common';
import { McpGatewayModule } from './mcp-gateway/mcp-gateway.module';

@Module({
  imports: [McpGatewayModule],
  exports: [McpGatewayModule]
})
export class IntegrationsModule {}
