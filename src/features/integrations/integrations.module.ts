import { Module } from '@nestjs/common';
import { FigmaIntegrationModule } from './figma/figma-integration.module';
import { GithubIntegrationModule } from './github/github-integration.module';
import { LinearIntegrationModule } from './linear/linear-integration.module';
import { McpGatewayModule } from './mcp-gateway/mcp-gateway.module';
import { NotionIntegrationModule } from './notion/notion-integration.module';

@Module({
  imports: [
    McpGatewayModule,
    GithubIntegrationModule,
    LinearIntegrationModule,
    NotionIntegrationModule,
    FigmaIntegrationModule
  ],
  exports: [McpGatewayModule]
})
export class IntegrationsModule {}
