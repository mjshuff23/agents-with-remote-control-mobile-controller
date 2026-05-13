import { Injectable } from '@nestjs/common';
import type {
  ILinearProvider,
  LinearTeam,
  LinearWorkflowState,
  LinearIssue,
  LinearSearchParams,
  LinearCreateLinkParams,
} from './linear-provider.interface';
import type { ProviderActionResult, NormalizedProviderError } from './provider.types';
import { AppConfigService } from '../../config/app-config.service';

const LINEAR_API = 'https://api.linear.app/graphql';

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

@Injectable()
export class LinearProvider implements ILinearProvider {
  readonly name = 'linear';
  private readonly token: string;

  constructor(private readonly config: AppConfigService) {
    this.token = config.linearToken ?? '';
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`Linear API responded with ${res.status}: ${text}`), { status: res.status });
    }

    const body = (await res.json()) as GqlResponse<T>;
    if (body.errors && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message).join('; ');
      throw new Error(`Linear GraphQL error: ${msg}`);
    }
    if (!body.data) {
      throw new Error('Linear API returned no data');
    }
    return body.data;
  }

  async searchIssues(params: LinearSearchParams): Promise<LinearIssue[]> {
    const filter: Record<string, unknown> = {};
    if (params.teamId) filter['team'] = { id: { eq: params.teamId } };
    if (params.stateId) filter['state'] = { id: { eq: params.stateId } };

    // Use searchIssues (text search) when a query term is provided, with server-side
    // team/state filters applied via the issues query as a fallback filter.
    // Linear's searchIssues does not support filter args, so we pass team/state
    // as additional filter variables and use the issues query with a term filter instead.
    if (params.query) {
      const searchFilter: Record<string, unknown> = { ...filter };
      searchFilter['or'] = [
        { title: { containsIgnoreCase: params.query } },
        { description: { containsIgnoreCase: params.query } },
      ];
      const data = await this.gql<{ issues: { nodes: RawLinearIssue[] } }>(
        `query SearchIssues($filter: IssueFilter, $first: Int) {
          issues(filter: $filter, first: $first, orderBy: updatedAt) {
            nodes { id identifier title description url team { id } state { id } labels { nodes { name } } }
          }
        }`,
        { filter: searchFilter, first: params.limit ?? 25 },
      );
      return data.issues.nodes.map(normalizeLinearIssue);
    }

    const data = await this.gql<{ issues: { nodes: RawLinearIssue[] } }>(
      `query ListIssues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes { id identifier title description url team { id } state { id } labels { nodes { name } } }
        }
      }`,
      { filter: Object.keys(filter).length > 0 ? filter : null, first: params.limit ?? 25 },
    );
    return data.issues.nodes.map(normalizeLinearIssue);
  }

  async getIssue(id: string): Promise<LinearIssue> {
    const data = await this.gql<{ issue: RawLinearIssue }>(
      `query GetIssue($id: String!) {
        issue(id: $id) { id identifier title description url team { id } state { id } labels { nodes { name } } }
      }`,
      { id },
    );
    return normalizeLinearIssue(data.issue);
  }

  async getTeams(): Promise<LinearTeam[]> {
    const data = await this.gql<{ teams: { nodes: Array<{ id: string; name: string; key: string }> } }>(
      `query GetTeams { teams { nodes { id name key } } }`,
    );
    return data.teams.nodes;
  }

  async getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const data = await this.gql<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string; position: number }> };
    }>(
      `query GetWorkflowStates($teamId: String!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }, orderBy: position) {
          nodes { id name type position }
        }
      }`,
      { teamId },
    );
    return data.workflowStates.nodes.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type as LinearWorkflowState['type'],
      position: s.position,
    }));
  }

  async updateIssueStatus(issueId: string, workflowStateId: string): Promise<ProviderActionResult> {
    const data = await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation UpdateIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
      }`,
      { issueId, stateId: workflowStateId },
    );
    if (!data.issueUpdate?.success) {
      return { provider: 'linear', externalId: issueId, status: 'failed', errorCategory: 'unexpected', errorMessage: 'issueUpdate returned success: false' };
    }
    return { provider: 'linear', externalId: issueId, status: 'succeeded' };
  }

  async attachLink(params: LinearCreateLinkParams): Promise<ProviderActionResult> {
    const data = await this.gql<{ attachmentLinkURL: { success: boolean } }>(
      `mutation AttachLink($issueId: String!, $url: String!, $title: String!) {
        attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
      }`,
      { issueId: params.issueId, url: params.url, title: params.label },
    );
    if (!data.attachmentLinkURL?.success) {
      return { provider: 'linear', externalId: params.issueId, status: 'failed', errorCategory: 'unexpected', errorMessage: 'attachmentLinkURL returned success: false' };
    }
    return { provider: 'linear', externalId: params.issueId, url: params.url, status: 'succeeded' };
  }

  normalizeError(error: unknown): NormalizedProviderError {
    const msg = error instanceof Error ? error.message : String(error);
    const status = error instanceof Error && 'status' in error ? (error as any).status : undefined;

    if (status === 401 || status === 403) {
      return { category: 'auth_failed', message: 'Linear authentication failed. Check your API key.', retryable: false, statusCode: status };
    }
    if (status === 404) {
      return { category: 'not_found', message: msg, retryable: false, statusCode: status };
    }
    if (status === 429) {
      return { category: 'rate_limited', message: 'Linear API rate limit exceeded', retryable: true, statusCode: status };
    }
    if (status && status >= 500) {
      return { category: 'network_error', message: 'Linear API server error', retryable: true, statusCode: status };
    }
    if (msg.includes('GraphQL error')) {
      return { category: 'validation_error', message: msg, retryable: false, statusCode: undefined };
    }
    if (status === undefined) {
      return { category: 'network_error', message: msg, retryable: true, statusCode: undefined };
    }
    return { category: 'unexpected', message: msg, retryable: false, statusCode: status };
  }
}

interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  team?: { id: string };
  state?: { id: string };
  labels?: { nodes: Array<{ name: string }> };
}

function normalizeLinearIssue(raw: RawLinearIssue): LinearIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    url: raw.url,
    teamId: raw.team?.id ?? '',
    stateId: raw.state?.id,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
  };
}
