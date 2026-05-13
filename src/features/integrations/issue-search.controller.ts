import { Controller, Get, Inject, Query, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { ControllerSecretGuard } from '../../common/guards/controller-secret.guard';
import { IGitHubProvider } from '../providers/github-provider.interface';
import type { IGitHubProvider as IGitHubProviderInterface, GitHubSearchIssue } from '../providers/github-provider.interface';
import { ILinearProvider } from '../providers/linear-provider.interface';
import type { ILinearProvider as ILinearProviderInterface, LinearIssue } from '../providers/linear-provider.interface';
import { IssueSearchQueryDto } from '../tasks/dto/issue-search-query.dto';
import type { IssueSearchResponse, NormalizedIssue } from '../tasks/dto/issue-search-response';

@Controller('issues')
@UseGuards(ControllerSecretGuard)
export class IssueSearchController {
  constructor(
    @Inject(IGitHubProvider) private readonly github: IGitHubProviderInterface,
    @Inject(ILinearProvider) private readonly linear: ILinearProviderInterface,
  ) {}

  @Get('search')
  async search(@Query() query: IssueSearchQueryDto): Promise<IssueSearchResponse> {
    const limit = query.limit ?? 25;

    try {
      if (query.provider === 'github') {
        const results = await this.github.searchIssues({
          repo: query.scope ?? '',
          query: query.query,
          state: 'open',
          limit,
        });
        return {
          provider: 'github',
          issues: results.map((i: GitHubSearchIssue): NormalizedIssue => ({
            provider: 'github',
            externalId: String(i.number),
            key: `#${i.number}`,
            title: i.title,
            url: i.url || undefined,
            state: i.state,
            labels: i.labels,
            body: i.body || undefined,
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
        issues: results.map((i: LinearIssue): NormalizedIssue => ({
          provider: 'linear',
          externalId: i.id,
          key: i.identifier,
          title: i.title,
          url: i.url || undefined,
          state: i.stateId ?? '',
          labels: i.labels,
          body: i.description,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        { detail: `Provider search failed: ${message}` },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
