export { ProvidersModule } from './providers.module';

export { IGitHubProvider } from './github-provider.interface';
export type {
  IGitHubProvider as IGitHubProviderInterface,
  GitHubSearchIssue,
  GitHubSearchParams,
  GitHubCreateBranchParams,
  GitHubCreateOrUpdatePrParams,
  GitHubPrInfo,
} from './github-provider.interface';

export { ILinearProvider } from './linear-provider.interface';
export type {
  ILinearProvider as ILinearProviderInterface,
  LinearTeam,
  LinearWorkflowState,
  LinearIssue,
  LinearSearchParams,
  LinearCreateLinkParams,
} from './linear-provider.interface';

export type {
  ProviderName,
  ProviderActionStatus,
  ProviderErrorCategory,
  ProviderActionResult,
  NormalizedProviderError,
  ExternalIssueRef,
} from './provider.types';

export { MockGitHubProvider } from './mock-github-provider';
export { MockLinearProvider } from './mock-linear-provider';
