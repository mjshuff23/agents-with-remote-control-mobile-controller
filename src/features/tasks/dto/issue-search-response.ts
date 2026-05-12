/** Provider-neutral issue shape returned by the issue search endpoint. */
export interface NormalizedIssue {
  provider: 'github' | 'linear';
  externalId: string;
  key: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
  body?: string;
}

export interface IssueSearchResponse {
  issues: NormalizedIssue[];
  provider: 'github' | 'linear';
}
