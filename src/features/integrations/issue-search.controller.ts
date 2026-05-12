import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ControllerSecretGuard } from '../../common/guards/controller-secret.guard';
import { IGitHubProvider } from '../providers/github-provider.interface';
import { ILinearProvider } from '../providers/linear-provider.interface';
import { IssueSearchQueryDto } from '../tasks/dto/issue-search-query.dto';
import type { IssueSearchResponse, NormalizedIssue } from '../tasks/dto/issue-search-response';

@Controller('issues')
@UseGuards(ControllerSecretGuard)
export class IssueSearchController {
  constructor(
    @Inject(IGitHubProvider) private readonly github: InstanceType<any>,
    @Inject(ILinearProvider) private readonly linear: InstanceType<any>,
  ) {}

  @Get('search')
  async search(@Query() query: IssueSearchQueryDto): Promise<IssueSearchResponse> {
    const limit = query.limit ?? 25;

    if (query.provider === 'github') {
      const repo = query.scope ?? '';
      const results = await this.github.searchIssues({
        repo,
        query: query.query,
        state: 'open',
        limit,
      });
      return {
        provider: 'github',
        issues: results.map((i: any): NormalizedIssue => ({
          provider: 'github',
          externalId: String(i.number),
          key: `#${i.number}`,
          title: i.title,
          url: i.url,
          state: i.state,
          labels: i.labels,
          body: i.body,
        })),
      };
    }

    // Linear
    const results = await this.linear.searchIssues({
      query: query.query,
      teamId: query.scope,
      stateId: query.stateId,
      limit,
    });
    return {
      provider: 'linear',
      issues: results.map((i: any): NormalizedIssue => ({
        provider: 'linear',
        externalId: i.id,
        key: i.identifier,
        title: i.title,
        url: i.url,
        state: i.stateId ?? '',
        labels: i.labels,
        body: i.description,
      })),
    };
  }
}
