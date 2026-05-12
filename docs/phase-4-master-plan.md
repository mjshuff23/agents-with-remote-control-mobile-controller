# Phase 4 Master Implementation Plan

> **Status:** Reference document for implementing TSH-80 child tickets in recommended order.
> Each ticket gets its own branch. Never advance until the previous ticket merges.

---

## TSH-107 — Provider adapter seams

**Branch:** `agent/TSH-107-provider-adapter-seams`

### TSH-107: Goal

Replace the stub `IIntegrationGateway` with proper provider adapter interfaces (`GitHubProvider`, `LinearProvider`) that keep API clients separate from orchestration. Add error normalization, mock providers, and the `SyncService` orchestration spine.

### TSH-107: Files to create

#### `src/features/providers/provider.types.ts`

Shared types for all providers:

```typescript
export type ProviderName = 'github' | 'linear';

export type ProviderActionStatus = 'succeeded' | 'failed' | 'retryable' | 'skipped';

export type ProviderErrorCategory =
  | 'auth_failed'
  | 'rate_limited'
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'network_error'
  | 'unexpected';

export interface ProviderActionResult {
  provider: ProviderName;
  externalId?: string;
  url?: string;
  status: ProviderActionStatus;
  errorCategory?: ProviderErrorCategory;
  errorMessage?: string;
}

export interface NormalizedProviderError {
  category: ProviderErrorCategory;
  message: string;
  retryable: boolean;
  statusCode?: number;
}
```

#### `src/features/providers/github-provider.interface.ts`

```typescript
import { ProviderActionResult, NormalizedProviderError } from './provider.types';

export interface GitHubSearchIssue {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  labels: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubSearchParams {
  repo: string;
  query?: string;
  labels?: string[];
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export interface GitHubCreateBranchParams {
  owner: string;
  repo: string;
  branchName: string;
  baseRef: string;
}

export interface GitHubCreateOrUpdatePrParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
  existingPrNumber?: number; // if set, update instead of create
}

export interface GitHubPrInfo {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt?: string;
  mergeCommitSha?: string;
  draft: boolean;
}

export interface IGitHubProvider {
  readonly name: 'github';
  isConfigured(): boolean;
  searchIssues(params: GitHubSearchParams): Promise<GitHubSearchIssue[]>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubSearchIssue>;
  createBranch(params: GitHubCreateBranchParams): Promise<ProviderActionResult>;
  createOrUpdatePR(params: GitHubCreateOrUpdatePrParams): Promise<ProviderActionResult & { prInfo?: GitHubPrInfo }>;
  getPR(owner: string, repo: string, prNumber: number): Promise<GitHubPrInfo>;
  listBranches(owner: string, repo: string): Promise<string[]>;
  normalizeError(error: unknown): NormalizedProviderError;
}
```

#### `src/features/providers/linear-provider.interface.ts`

```typescript
import { ProviderActionResult, NormalizedProviderError } from './provider.types';

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: 'started' | 'unstarted' | 'completed' | 'canceled';
  position: number;
}

export interface LinearIssue {
  id: string;
  identifier: string; // e.g., "TSH-107"
  title: string;
  description?: string;
  stateId?: string;
  url: string;
  teamId: string;
  labels: string[];
}

export interface LinearSearchParams {
  query?: string;
  teamId?: string;
  stateId?: string;
  limit?: number;
}

export interface LinearCreateLinkParams {
  issueId: string;
  url: string;
  label: string;
}

export interface ILinearProvider {
  readonly name: 'linear';
  isConfigured(): boolean;
  searchIssues(params: LinearSearchParams): Promise<LinearIssue[]>;
  getIssue(identifier: string): Promise<LinearIssue>;
  getTeams(): Promise<LinearTeam[]>;
  getWorkflowStates(teamId: string): Promise<LinearWorkflowState[]>;
  updateIssueStatus(issueId: string, workflowStateId: string): Promise<ProviderActionResult>;
  attachLink(params: LinearCreateLinkParams): Promise<ProviderActionResult>;
  normalizeError(error: unknown): NormalizedProviderError;
}
```

#### `src/features/providers/mock-github-provider.ts`

```typescript
// In-memory mock for tests. Implements IGitHubProvider.
// Stores issues, branches, PRs in maps.
// All methods return canned or stored data.
// normalizeError returns { category: 'unexpected', message: String(error), retryable: false }.
```

#### `src/features/providers/mock-linear-provider.ts`

```typescript
// In-memory mock for tests. Implements ILinearProvider.
// Stores teams, workflow states, issues, links in maps.
// All methods return canned or stored data.
```

#### `src/features/providers/providers.module.ts`

```typescript
// @Module({ providers: [], exports: [] })
// Empty — providers are injected via useClass/useValue in the consumer module
// or assembled at the app module level based on config.
```

#### `src/features/providers/index.ts`

Re-exports all interfaces, types, and mock implementations.

### TSH-107: Files to modify

#### Current `GithubAdapter`/`LinearAdapter` — keep as is or remove

The existing stubs in `src/features/integrations/github/` and `linear/` implement the old `IIntegrationGateway` interface. Phase 4 adds the new provider interfaces alongside. The old `IntegrationsModule` can remain for Phase 5 MCP work. The new Phase 4 provider interfaces live in `src/features/providers/`.

### Test files to create

#### `src/features/providers/mock-github-provider.spec.ts`

#### `src/features/providers/mock-linear-provider.spec.ts`

### TSH-107: AC checklist

- [x] All type definitions exist in `provider.types.ts`
- [ ] `IGitHubProvider` interface defined with full method signatures
- [ ] `ILinearProvider` interface defined with full method signatures
- [ ] `MockGitHubProvider` implements interface with in-memory stores
- [ ] `MockLinearProvider` implements interface with in-memory stores
- [ ] Error normalization produces stable categories
- [ ] Tests pass without real provider access
- [ ] Branch merges to main

---

## TSH-99 — SyncEvent idempotency model

**Branch:** `agent/TSH-99-syncevent-idempotency`

### TSH-99: Goal

Add the durable `SyncEvent` Prisma model and service so every provider sync action is idempotent. Retries reuse existing event records instead of creating duplicates.

### TSH-99: Files to create

#### `prisma/migrations/XXXX_add_syncevent/migration.sql`

#### Prisma model (add to `schema.prisma`)

```prisma
model SyncEvent {
  id             String   @id @default(uuid())
  taskId         String
  sessionId      String?
  provider       String   // 'github' | 'linear'
  action         String   // 'create_branch' | 'commit' | 'push' | 'create_pr' | 'update_pr' | 'update_issue_status' | 'attach_link'
  targetId       String   // provider-specific external ID (issue number, PR number, Linear issue ID)
  status         String   // 'pending' | 'running' | 'succeeded' | 'failed' | 'retryable' | 'skipped'
  externalId     String?  // provider-assigned ID (PR number, Linear issue ID)
  url            String?  // provider-assigned URL
  errorCategory  String?  // normalized error category
  errorMessage   String?  // recovery-safe error summary (no credentials/config)
  metadataJson   String?  // optional JSON for recovery-safe extra data
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([taskId, provider, targetId, action])
  @@index([taskId])
  @@index([taskId, status])
  @@index([taskId, action])
}
```

#### `prisma/TSH99-SyncEvent.txt` (manual docs for Prisma schema change)

Reference file documenting the model design decisions.

#### `src/features/sync/sync-event.service.ts`

```typescript
export class SyncEventService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrReuse(input: {
    taskId: string;
    sessionId?: string;
    provider: string;
    action: string;
    targetId: string;
  }): Promise<SyncEvent> { /* findUnique by unique constraint; create if not exists */ }

  async markRunning(id: string): Promise<SyncEvent> { /* update status to running */ }
  async markSucceeded(id: string, externalId?: string, url?: string): Promise<SyncEvent> { /* update */ }
  async markFailed(id: string, errorCategory: string, errorMessage: string): Promise<SyncEvent> { /* update */ }
  async markRetryable(id: string): Promise<SyncEvent> { /* update */ }
  async markSkipped(id: string): Promise<SyncEvent> { /* update */ }

  async listForTask(taskId: string): Promise<SyncEvent[]> { /* findMany ordered by createdAt */ }

  async getLastForAction(taskId: string, provider: string, action: string, targetId: string): Promise<SyncEvent | null> {
    /* findFirst by unique constraint */
  }
}
```

#### `src/features/sync/sync-event.service.spec.ts`

Unit tests covering:

- createOrReuse creates new record on first call, returns existing on second
- markRunning transitions from pending
- markSucceeded transitions from running
- markFailed transitions from running
- markRetryable transitions from running
- markSkipped transitions from pending
- duplicate suppression via unique constraint
- listForTask returns ordered results

#### `src/features/sync/sync.module.ts`

```typescript
@Module({
  imports: [PrismaModule],
  providers: [SyncEventService],
  exports: [SyncEventService],
})
export class SyncModule {}
```

### TSH-99: Files to modify

#### `prisma/schema.prisma` — add SyncEvent model

#### `src/features/tasks/tasks.service.ts` — no changes yet (SyncEvent is a foundation, not wired into tasks until TSH-108)

### TSH-99: AC checklist

- [ ] Prisma model created and migration generated
- [ ] `SyncEventService` has all 8 methods
- [ ] Uniqueness constraint `(taskId, provider, targetId, action)` enforced
- [ ] State transitions are deterministic (no illegal transitions)
- [ ] Unit tests cover duplicate suppression
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-97 — GitHub access model

**Branch:** `agent/TSH-97-github-access-model`

### TSH-97: Goal

Choose and document the GitHub access model. Add `.env.example` placeholders, min permissions docs, and the concrete `GitHubProvider` implementation backed by fine-grained PAT.

### Decision: Fine-grained PAT (MVP)

**Rationale:** For a local LAN controller, a fine-grained personal access token is the simplest path — no OAuth flow, no GitHub App setup, no webhook configuration. The hardened path (GitHub App) is documented as a later option.

**Minimum required permissions:**

| Action | Permission | Scope |
|--------|-----------|-------|
| Search issues | Issues: Read | metadata |
| Read issue | Issues: Read | metadata |
| Create branch | Contents: Write | metadata |
| Push commits | Contents: Write | metadata |
| Create draft PR | Pull requests: Write | metadata |
| Read PR status | Pull requests: Read | metadata |
| Check merge status | Pull requests: Read | metadata |

### TSH-97: Files to create

#### `src/features/providers/github-provider.ts`

Concrete implementation of `IGitHubProvider` using Octokit (or raw fetch):

```typescript
@Injectable()
export class GitHubProvider implements IGitHubProvider {
  readonly name = 'github';
  private octokit: Octokit | null = null;

  constructor(private readonly config: AppConfigService) {
    const token = this.config.gitHubToken;
    if (token) {
      this.octokit = new Octokit({ auth: token });
    }
  }

  isConfigured(): boolean { return this.octokit !== null; }

  // searchIssues: GET /search/issues?q=...
  // getIssue: GET /repos/{owner}/{repo}/issues/{number}
  // createBranch: GET /repos/{owner}/{repo}/git/refs/heads/{base} to get SHA
  //              then POST /repos/{owner}/{repo}/git/refs with {ref: "refs/heads/{name}", sha}
  // createOrUpdatePR: POST/PATCH /repos/{owner}/{repo}/pulls
  // getPR: GET /repos/{owner}/{repo}/pulls/{number}
  // listBranches: GET /repos/{owner}/{repo}/branches
  // normalizeError: map axios/octokit errors to NormalizedProviderError
}
```

Note: Implement Octokit via import or vendored REST client. Check if `octokit` or `@octokit/rest` is already a dependency (it's not — we may need to add it or use raw `fetch`). Prefer raw `fetch` (available in Node 26) to avoid adding a dependency.

#### `src/features/providers/github-provider.spec.ts`

Mock-based unit tests:

- isConfigured returns false when no token
- searchIssues returns parsed results
- createBranch calls correct API
- normalizeError maps HTTP 401 → auth_failed, 403 → rate_limited, 404 → not_found

### TSH-97: Files to modify

#### `.env.example` — add

```bash
# GitHub fine-grained PAT (min scopes: issues:read, contents:write, pull_requests:write)
ARC_GITHUB_TOKEN=
ARC_GITHUB_OWNER=
ARC_GITHUB_REPO=
```

#### `src/config/env.validation.ts` — add optional validation

```typescript
@IsOptional() @IsString() ARC_GITHUB_TOKEN?: string;
@IsOptional() @IsString() ARC_GITHUB_OWNER?: string;
@IsOptional() @IsString() ARC_GITHUB_REPO?: string;
```

#### `src/config/app-config.service.ts` — add accessors

```typescript
get gitHubToken(): string | undefined { return this.config.get('ARC_GITHUB_TOKEN'); }
get gitHubOwner(): string | undefined { return this.config.get('ARC_GITHUB_OWNER'); }
get gitHubRepo(): string | undefined { return this.config.get('ARC_GITHUB_REPO'); }
```

#### `src/features/providers/providers.module.ts` — register GitHubProvider

```typescript
{ provide: IGitHubProvider, useClass: GitHubProvider }
```

### TSH-97: AC checklist

- [ ] GitHub access model documented with rationale
- [ ] `.env.example` has `ARC_GITHUB_TOKEN`, `ARC_GITHUB_OWNER`, `ARC_GITHUB_REPO`
- [ ] `GitHubProvider` implements all interface methods
- [ ] Tests cover configured and unconfigured states
- [ ] Error normalization maps HTTP errors to stable categories
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-98 — Linear access model + status mapping

**Branch:** `agent/TSH-98-linear-access-model`

### TSH-98: Goal

Choose and document the Linear access model. Add `.env.example` placeholders, status mapping config, workflow state discovery, and the concrete `LinearProvider` implementation.

### Decision: Personal API key (MVP)

**Rationale:** Linear personal API keys are simple, stable, and sufficient for a single-user local controller. The hardened path (OAuth) is documented for multi-user/future use.

### TSH-98: Files to create

#### `src/features/providers/linear-provider.ts`

Concrete implementation of `ILinearProvider` using raw `fetch`:

```typescript
@Injectable()
export class LinearProvider implements ILinearProvider {
  readonly name = 'linear';
  private apiKey: string | null = null;

  constructor(private readonly config: AppConfigService) {
    this.apiKey = config.linearApiKey || null;
  }

  isConfigured(): boolean { return this.apiKey !== null; }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    // POST https://api.linear.app/graphql with Authorization: Bearer {apiKey}
    // Handle errors, rate limiting
  }

  // searchIssues: searchIssues query with optional filters
  // getIssue: issue(id or identifier) query
  // getTeams: teams query
  // getWorkflowStates: workflowStates for team query
  // updateIssueStatus: issueUpdate mutation with stateId
  // attachLink: attachmentCreate mutation with issueId, url, title
  // normalizeError: map HTTP/API errors
}
```

#### `src/features/providers/linear-status-mapper.ts`

Status mapping service:

```typescript
export interface LinearStatusMapping {
  [localState: string]: string; // e.g. { "in_progress": "In Progress", "done": "Done" }
}

export class LinearStatusMapper {
  // Given configured mapping and discovered workflow states,
  // resolve a local state name to a workflow state ID.
  async resolveTargetState(
    linear: ILinearProvider,
    teamId: string,
    configuredMapping: LinearStatusMapping,
    targetLocalState: string
  ): Promise<{ stateId: string; stateName: string } | null> {
    const states = await linear.getWorkflowStates(teamId);
    const configuredName = configuredMapping[targetLocalState];
    if (!configuredName) return null;
    const match = states.find(s => s.name === configuredName);
    return match ? { stateId: match.id, stateName: match.name } : null;
  }
}
```

#### `src/features/providers/linear-provider.spec.ts`

#### `src/features/providers/linear-status-mapper.spec.ts`

### TSH-98: Files to modify

#### TSH-98: `.env.example` — add

```bash
# Linear personal API key (min scopes: issues:read, issues:write)
ARC_LINEAR_API_KEY=
ARC_LINEAR_TEAM_ID=
# Map local lifecycle states to Linear workflow state names
# Format: ARC_LINEAR_STATUS_MAPPING='{"in_progress":"In Progress","done":"Done","canceled":"Canceled"}'
ARC_LINEAR_STATUS_MAPPING=
```

#### TSH-98: `src/config/env.validation.ts` — add optional validation

```typescript
@IsOptional() @IsString() ARC_LINEAR_API_KEY?: string;
@IsOptional() @IsString() ARC_LINEAR_TEAM_ID?: string;
@IsOptional() @IsString() ARC_LINEAR_STATUS_MAPPING?: string;
```

#### TSH-98: `src/config/app-config.service.ts` — add accessors

```typescript
get linearApiKey(): string | undefined { return this.config.get('ARC_LINEAR_API_KEY'); }
get linearTeamId(): string | undefined { return this.config.get('ARC_LINEAR_TEAM_ID'); }
get linearStatusMapping(): Record<string, string> {
  const raw = this.config.get('ARC_LINEAR_STATUS_MAPPING');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
```

#### `src/features/providers/providers.module.ts` — register

```typescript
{ provide: ILinearProvider, useClass: LinearProvider }
LinearStatusMapper
```

### TSH-98: AC checklist

- [ ] Linear access model documented with rationale
- [ ] `.env.example` has `ARC_LINEAR_API_KEY`, `ARC_LINEAR_TEAM_ID`, `ARC_LINEAR_STATUS_MAPPING`
- [ ] `LinearProvider` implements all interface methods via GraphQL
- [ ] `LinearStatusMapper` resolves configured state names to discovered IDs
- [ ] Missing-state fallback returns null (no crash)
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-100 — Issue picker + task-linking UX

**Branch:** `agent/TSH-100-issue-picker-ux`

### TSH-100: Goal

Add the mobile-first flow for creating an agent task from a GitHub issue, Linear issue, or manual prompt. New endpoints for provider-agnostic issue search, extended task creation with external ref, and the controller issue picker UI.

### TSH-100: Files to create

#### `src/features/providers/issue-search.service.ts`

Orchestration service that composes GitHub and Linear providers:

```typescript
@Injectable()
export class IssueSearchService {
  constructor(
    @Inject(IGitHubProvider) private readonly github?: IGitHubProvider,
    @Inject(ILinearProvider) private readonly linear?: ILinearProvider,
  ) {}

  async search(input: {
    provider?: 'github' | 'linear';
    query?: string;
    limit?: number;
  }): Promise<{
    issues: Array<{
      provider: 'github' | 'linear';
      externalId: string;
      key: string;       // e.g. "GH-5" or "TSH-107"
      title: string;
      url: string;
      state: string;
      labels: string[];
    }>;
  }> { /* search configured providers, normalize results */ }
}
```

#### `src/features/tasks/dto/create-task.dto.ts` — extend (see below)

#### `src/features/tasks/tasks.controller.ts` — add endpoint

```typescript
@Get('issues/search')
async searchIssues(@Query('provider') provider?: string, @Query('q') q?: string) {
  return this.issueSearch.search({ provider: provider as any, query: q });
}
```

#### `controller/app/new-task/page.tsx` — rewrite to include issue picker

#### `controller/components/issue-picker.tsx`

```typescript
// Wireframe:
// - Dropdown to select source: "Manual", "GitHub Issue", "Linear Issue"
// - If GitHub/Linear selected: show search input + results list
// - Selecting an issue fills: title, prompt (generated from issue body), externalIssue metadata
// - Preview of branch slug (read-only)
// - Editable prompt textarea
// - Agent selector (codex)
// - Create button
```

### TSH-100: Files to modify

#### `src/features/tasks/dto/create-task.dto.ts`

```typescript
// Add optional externalIssue block:
export class ExternalIssueRef {
  @IsIn(['github', 'linear'])
  provider!: 'github' | 'linear';

  @IsString()
  externalId!: string;

  @IsString()
  key!: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  title?: string;
}

export class CreateTaskDto {
  // ... existing fields ...
  
  @IsOptional()
  @ValidateNested()
  @Type(() => ExternalIssueRef)
  externalIssue?: ExternalIssueRef;
}
```

#### `prisma/schema.prisma` — Add `externalIssueJson` and `externalIssueProvider` to `Task`

```prisma
model Task {
  // ... existing fields ...
  externalIssueProvider String?   // 'github' | 'linear'
  externalIssueKey     String?   // issue key for display/reference
  externalIssueJson    String?   // full external ref metadata JSON
}
```

#### `src/features/tasks/tasks.service.ts` — update `createTask()`

- Pass `externalIssue` data through to Task create
- Store in `externalIssueProvider`, `externalIssueKey`, `externalIssueJson`

#### `src/features/tasks/tasks.service.ts` — update `TaskDetails` interface

```typescript
export interface TaskDetails {
  // ... existing fields ...
  externalIssue?: {
    provider: string;
    externalId: string;
    key: string;
    url?: string;
    title?: string;
  };
}
```

#### `controller/lib/api.ts` — add types and functions

- `ExternalIssueRef` type
- `searchIssues()` API function
- Update `CreateTaskDto` type

### TSH-100: AC checklist

- [ ] `IssueSearchService` returns normalized results from configured providers
- [ ] `GET /tasks/issues/search` endpoint exists and is controller-guarded
- [ ] Task creation accepts optional `externalIssue`
- [ ] Task stores `externalIssueProvider`, `externalIssueKey`, `externalIssueJson`
- [ ] `TaskDetails` response includes parsed `externalIssue`
- [ ] Controller issue picker renders source selector + search + create flow
- [ ] Generated prompt is editable before launch
- [ ] Mobile layout works for narrow screens
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-101 — Branch naming + worktree lifecycle

**Branch:** `agent/TSH-101-branch-worktree-lifecycle`

### TSH-101: Goal

When a task is linked to an external issue, generate a deterministic branch name with the issue key, handle branch/worktree collisions, pick the base branch explicitly, and refuse dirty worktree state.

### TSH-101: Files to modify

#### `src/features/worktrees/git-worktree.service.ts`

**Updated branch naming:**

```typescript
// Current: agent/{taskId}-{slug}
// New with issue: agent/{provider}-{issueKey}-{slug}
// New without issue: agent/{taskId}-{slug}
// Slug generation: lowercase, strip non-alphanumeric except hyphens, max 30 chars
// Collision detection: if branch exists, append -1, -2, etc.
```

**Updated `createForTask()` signature:**

```typescript
async createForTask(input: WorktreeInput & {
  externalIssue?: { provider: string; key: string };
  baseRefOverride?: string; // explicit base branch override
}): Promise<WorktreeResult>
```

**Dirty repo guard:**

```typescript
// Before creating worktree, check if main checkout is clean
// git status --porcelain on repoPath
// If not clean, throw with message about dirty state
```

**Worktree cleanup methods:**

```typescript
async removeWorktree(taskId: string, worktreePath: string): Promise<void> {
  // git worktree remove {worktreePath}
  // Emit worktree.cleanup_completed event
}

async pruneWorktrees(): Promise<void> {
  // git worktree prune
  // Remove stale worktree directories
}
```

### TSH-101: Files to create

#### `src/features/worktrees/branch-naming.service.ts`

```typescript
export class BranchNamingService {
  generateBranchName(input: {
    taskId: string;
    title?: string | null;
    prompt: string;
    externalIssue?: { provider: string; key: string } | null;
    existingBranches?: string[];
  }): string {
    // Generate base name
    // Handle collisions with -1, -2 suffix
    // Max length 80 chars
  }

  slugify(text: string, maxLength: number = 30): string {
    // lowercase, replace [^a-z0-9]+ with -, trim edges
  }
}
```

#### `src/features/worktrees/branch-naming.service.spec.ts`

#### `src/features/worktrees/git-worktree.service.spec.ts` — add tests

- Branch name includes issue key when present
- Collision appends numeric suffix
- Dirty repo throws
- Worktree cleanup works

### TSH-101: AC checklist

- [ ] Branch format is `agent/{provider}-{issueKey}-{slug}` when linked, `agent/{taskId}-{slug}` fallback
- [ ] Collision handling tested with unit tests
- [ ] Base branch selection is explicit and observable
- [ ] Dirty repo throws descriptive error
- [ ] Worktree cleanup (`removeWorktree`, `pruneWorktrees`) implemented
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-108 — Approval/audit/sync integration

**Branch:** `agent/TSH-108-approval-audit-sync-integration`

### TSH-108: Goal

Define and implement the relationship between approvals, audit logs, and sync events. Map which Phase 4 actions require approval, which can auto-run, and wire `SyncEvent` into the audit trail.

### TSH-108: Files to create

#### `src/features/sync/sync-orchestrator.service.ts`

Central orchestration service:

```typescript
@Injectable()
export class SyncOrchestratorService {
  constructor(
    private readonly syncEvents: SyncEventService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditLogService,
    private readonly events: EventsGateway,
    @Optional() @Inject(IGitHubProvider) private readonly github?: IGitHubProvider,
    @Optional() @Inject(ILinearProvider) private readonly linear?: ILinearProvider,
  ) {}

  async executeSyncAction(input: {
    taskId: string;
    sessionId?: string;
    provider: 'github' | 'linear';
    action: string;
    targetId: string;
    requiresApproval: boolean;
    execute: () => Promise<ProviderActionResult>;
  }): Promise<{ syncEvent: SyncEvent; approvalResult?: CreateApprovalResult }> {
    // 1. Create or reuse SyncEvent
    // 2. If requiresApproval → create approval request
    // 3. Wait for approval resolution (or skip if auto)
    // 4. Mark SyncEvent as running
    // 5. Execute provider action
    // 6. Mark SyncEvent as succeeded/failed/retryable
    // 7. Create audit log entry for the outcome
    // 8. Emit sync event via gateway
  }

  private async auditSyncOutcome(input: {
    taskId: string;
    sessionId?: string;
    syncEvent: SyncEvent;
    status: string;
    message: string;
  }): Promise<void> {
    await this.audit.append({
      taskId: input.taskId,
      sessionId: input.sessionId,
      kind: `sync.${input.status}`,
      actionType: `provider.${input.syncEvent.provider}.${input.syncEvent.action}`,
      message: input.message,
      metadata: {
        syncEventId: input.syncEvent.id,
        provider: input.syncEvent.provider,
        action: input.syncEvent.action,
        externalId: input.syncEvent.externalId,
        errorCategory: input.syncEvent.errorCategory,
      },
    });
  }
}
```

#### `src/features/sync/sync-orchestrator.service.spec.ts`

### Approval-Required Action Matrix

| Action | Requires Approval | Auto After Prior | Notes |
|--------|-------------------|-----------------|-------|
| `github.create_branch` | Yes (if new) | No | First time for task requires approval |
| `github.commit` | Yes | No | Always requires explicit approval |
| `github.push` | Yes | No | Always requires explicit approval |
| `github.create_pr` | Yes | No | Always requires explicit approval |
| `github.update_pr` | No | Yes | Only after PR created in same task |
| `linear.update_status` | Yes | No | Status sync requires explicit approval |
| `linear.attach_link` | No | Yes | Only after PR created in same task |

### TSH-108: Files to modify

#### `src/features/providers/providers.module.ts` — register `SyncOrchestratorService`

#### `src/features/app.module.ts` — import `SyncModule`

### TSH-108: AC checklist

- [ ] `SyncOrchestratorService.executeSyncAction` handles full lifecycle
- [ ] Approval matrix documented and implemented
- [ ] Auto-run actions skip approval when prior approval covers them
- [ ] Every sync outcome creates an audit log entry
- [ ] Sync events emit via gateway for controller visibility
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-102 — Approved commit flow + signing checks

**Branch:** `agent/TSH-102-approved-commit-flow`

### TSH-102: Goal

Add approval-gated commit creation in the task worktree. Detect signing config, surface warnings, and capture commit SHA.

### TSH-102: Files to modify

#### `src/features/providers/git-commit.service.ts` (new)

```typescript
@Injectable()
export class GitCommitService {
  constructor(
    private readonly gitCommands: GitCommandService,
    private readonly syncOrchestrator: SyncOrchestratorService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditLogService,
    private readonly events: EventsGateway,
  ) {}

  async requestCommit(input: {
    taskId: string;
    sessionId: string;
    worktreePath: string;
    message: string;
    task: { title?: string | null; externalIssueKey?: string | null; externalIssueProvider?: string | null };
  }): Promise<{ approvalResult: CreateApprovalResult }> {
    // 1. Check for local git signing config
    // 2. Generate commit message template
    // 3. Request approval for commit action
    // 4. Return approval result (caller must wait for human decision)
  }

  async executeCommit(input: {
    taskId: string;
    sessionId: string;
    worktreePath: string;
    message: string;
    approvalId: string;
  }): Promise<{ commitSha: string; signed: boolean }> {
    // 1. Verify approval is approved
    // 2. Run `git -C {worktree} add -A`
    // 3. Run `git -C {worktree} commit -m {message}`
    // 4. Capture commit SHA from rev-parse HEAD
    // 5. Check if commit is signed (git log --format=%GG)
    // 6. Create SyncEvent
    // 7. Update task with commitSha
    // 8. Return result
  }

  private generateCommitMessage(task: {
    title?: string | null;
    externalIssueKey?: string | null;
    externalIssueProvider?: string | null;
  }, summary?: string): string {
    // Format:
    // {title or summary}
    // (blank line)
    // Refs: {issueKey} (if present)
  }

  async checkSigningConfig(worktreePath: string): Promise<{
    signingKeyConfigured: boolean;
    signingKey?: string;
    warning?: string;
  }> {
    // git config user.signingkey
    // git config commit.gpgsign
  }
}
```

#### `src/features/providers/git-commit.service.spec.ts`

#### `src/features/tasks/tasks.controller.ts` — add endpoints

```typescript
@Post(':id/commit')
@HttpCode(202)
async requestCommit(@Param('id') id: string) {
  // Request commit approval
}

@Post(':id/commit/execute')
@HttpCode(202)
async executeCommit(@Param('id') id: string, @Body() body: { approvalId: string; message?: string }) {
  // Execute approved commit
}
```

### Commit message template

```text
{summary}

Refs: {issueKey}  (if present)
Task: {taskId}
```

### TSH-102: AC checklist

- [ ] Commit requires explicit approval (action type: `git.commit`)
- [ ] `requestCommit` creates approval request + emits event
- [ ] `executeCommit` verifies approval, stages all, commits, captures SHA
- [ ] Commit message follows template format
- [ ] Signing detection surfaces config state and warnings
- [ ] Commit SHA is persisted to task/sync metadata
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-103 — Approved push flow + remote protection

**Branch:** `agent/TSH-103-approved-push-flow`

### TSH-103: Goal

Add approval-gated push to the task worktree branch. Verify remote and branch before pushing, refuse force-push, and capture push metadata.

### TSH-103: Files to create

#### `src/features/providers/git-push.service.ts`

```typescript
@Injectable()
export class GitPushService {
  constructor(
    private readonly gitCommands: GitCommandService,
    private readonly syncOrchestrator: SyncOrchestratorService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditLogService,
    private readonly events: EventsGateway,
  ) {}

  async requestPush(input: {
    taskId: string;
    sessionId: string;
    repoPath: string;
    worktreePath: string;
    branchName: string;
  }): Promise<{ approvalResult: CreateApprovalResult }> {
    // 1. Verify remote exists
    // 2. Verify branch is valid
    // 3. Check for force-push risk
    // 4. Request approval
  }

  async executePush(input: {
    taskId: string;
    sessionId: string;
    repoPath: string;
    worktreePath: string;
    branchName: string;
    approvalId: string;
  }): Promise<{ pushed: boolean; remoteUrl?: string; ref?: string }> {
    // 1. Verify approval
    // 2. Validate no force-push flag in args
    // 3. Run `git push origin {branchName}`
    // 4. Capture remote tracking ref
    // 5. Create SyncEvent
    // 6. Update task with pushed branch metadata
  }

  private async verifyRemote(repoPath: string): Promise<{
    exists: boolean;
    url?: string;
    validProtocol: boolean;
  }> {
    // git remote get-url origin
    // Verify it starts with https:// or git@
  }
}
```

#### `src/features/providers/git-push.service.spec.ts`

### TSH-103: Files to modify

#### TSH-103: `src/features/tasks/tasks.controller.ts` — add endpoints

```typescript
@Post(':id/push')
@HttpCode(202)
async requestPush(@Param('id') id: string) { }

@Post(':id/push/execute')
@HttpCode(202)
async executePush(@Param('id') id: string, @Body() body: { approvalId: string }) { }
```

### TSH-103: AC checklist

- [ ] Push requires explicit approval (action type: `git.push`)
- [ ] Remote verification before push
- [ ] Force-push detection and refusal
- [ ] Remote URL validated as non-local
- [ ] Branch ref metadata captured on success
- [ ] Commit SHA + push ref are tracked separately
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-104 — Draft PR creation + generated summary

**Branch:** `agent/TSH-104-draft-pr-creation`

### TSH-104: Goal

Add approval-gated draft PR creation after push. Generate PR body from agent session logs, diff summary, test results, and approval history. Idempotent: reuse/update existing PR for same branch.

### TSH-104: Files to create

#### `src/features/providers/pr-generator.service.ts`

```typescript
@Injectable()
export class PrGeneratorService {
  constructor(
    private readonly gitDiff: GitDiffService,
    private readonly prisma: PrismaService,
    private readonly syncOrchestrator: SyncOrchestratorService,
  ) {}

  async generatePrBody(input: {
    taskId: string;
    externalIssue?: { provider: string; key: string; url?: string };
  }): Promise<string> {
    // Gather:
    // - Task title/prompt
    // - External issue link
    // - Diff summary (files changed, stats)
    // - Test results (passed/failed)
    // - Approval count
    // - Known risks from riskFlags
    // Format into PR template
  }

  async requestPrCreation(input: {
    taskId: string;
    sessionId: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
  }): Promise<{ approvalResult: CreateApprovalResult }> {
    // 1. Check if existing PR for this branch (via SyncEvent)
    // 2. Generate PR body
    // 3. Request approval
  }

  async executePrCreation(input: {
    taskId: string;
    sessionId: string;
    approvalId: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ prNumber: number; prUrl: string; created: boolean; updated: boolean }> {
    // 1. Verify approval
    // 2. Check existing PR via SyncEvent
    // 3. If exists: PATCH existing PR (update body)
    // 4. If not: POST create draft PR
    // 5. Create SyncEvent with PR URL/number
    // 6. Update task with prNumber, prUrl
  }
}
```

#### `src/features/providers/pr-generator.service.spec.ts`

### PR Body Template

```markdown
## Summary

{task prompt or title}

## Linked Issues

- {external issue link} (if present)
- Task: {taskId}

## Changes

- {files changed} files changed, +{insertions} / -{deletions}
- Added: {added}, Modified: {modified}, Deleted: {deleted}, Renamed: {renamed}

## Tests

{test results table or summary}

## Approvals

{count of human-approved actions}

## Known Risks

{risk flags from diff summary, or "None identified"}

## Follow-ups

- {generated from session context}
```

### TSH-104: Files to modify

#### TSH-104: `src/features/tasks/tasks.controller.ts` — add endpoints

```typescript
@Post(':id/pr')
@HttpCode(202)
async requestPr(@Param('id') id: string) { }

@Post(':id/pr/execute')
@HttpCode(202)
async executePr(@Param('id') id: string, @Body() body: { approvalId: string; title?: string }) { }
```

### TSH-104: AC checklist

- [ ] Draft PR creation requires approval (action type: `provider.github.create_pr`)
- [ ] PR body follows documented template with all sections
- [ ] Duplicate create attempts update existing PR (not duplicate creation)
- [ ] PR URL and number stored in task metadata + SyncEvent
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-105 — Linear-GitHub cross-reference sync

**Branch:** `agent/TSH-105-linear-github-cross-reference`

### TSH-105: Goal

Link GitHub PRs and Linear issues bidirectionally: PR body references Linear issue, Linear issue gets PR URL as a link attachment. Idempotent via SyncEvent.

### TSH-105: Files to create

#### `src/features/providers/cross-reference.service.ts`

```typescript
@Injectable()
export class CrossReferenceService {
  constructor(
    private readonly syncEvents: SyncEventService,
    private readonly syncOrchestrator: SyncOrchestratorService,
    @Optional() @Inject(ILinearProvider) private readonly linear?: ILinearProvider,
    @Optional() @Inject(IGitHubProvider) private readonly github?: IGitHubProvider,
  ) {}

  async syncPrToLinear(input: {
    taskId: string;
    sessionId: string;
    linearIssueId: string;
    prUrl: string;
    prTitle: string;
  }): Promise<void> {
    // 1. Attach PR URL as link to Linear issue (idempotent via SyncEvent)
    // 2. Optionally update PR description with Linear issue link
  }

  async ensurePrBodyHasLinearRef(input: {
    taskId: string;
    owner: string;
    repo: string;
    prNumber: number;
    linearIssueKey: string;
    linearIssueUrl: string;
  }): Promise<void> {
    // 1. Get existing PR body
    // 2. If body already has ref/url: skip
    // 3. Otherwise: update PR body with Linear reference
  }
}
```

#### `src/features/providers/cross-reference.service.spec.ts`

### Cross-reference rules

| Direction | Method | Idempotency Key |
|-----------|--------|----------------|
| PR body → Linear issue ref | Update PR body text | `(taskId, github, {prNumber}, add_linear_ref)` |
| Linear issue → PR URL link | `attachmentCreate` mutation | `(taskId, linear, {issueId}, attach_pr_url)` |
| PR comment → Linear ref | Skip (noise) | N/A |

### TSH-105: AC checklist

- [ ] PR body includes Linear issue key/link when present
- [ ] Linear issue gets PR URL as link attachment
- [ ] Duplicate link attempts prevented by SyncEvent idempotency
- [ ] Cross-reference rules documented
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-106 — PR merge detection + Linear completion sync

**Branch:** `agent/TSH-106-pr-merge-detection`

### TSH-106: Goal

Detect PR merge events (MVP: manual refresh/polling) and update linked Linear issues to Done status, idempotently.

### TSH-106: Files to create

#### `src/features/providers/merge-detection.service.ts`

```typescript
@Injectable()
export class MergeDetectionService {
  constructor(
    private readonly syncEvents: SyncEventService,
    private readonly syncOrchestrator: SyncOrchestratorService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(IGitHubProvider) private readonly github?: IGitHubProvider,
    @Optional() @Inject(ILinearProvider) private readonly linear?: ILinearProvider,
    @Optional() private readonly statusMapper?: LinearStatusMapper,
  ) {}

  async checkMergeStatus(taskId: string, owner: string, repo: string, prNumber: number): Promise<{
    merged: boolean;
    mergeCommitSha?: string;
    prState: 'open' | 'closed' | 'merged';
  }> {
    // Get PR via GitHubProvider.getPR
    // Check state: 'merged' or (closed with merge_commit_sha)
  }

  async handleMergedPr(input: {
    taskId: string;
    sessionId?: string;
    prNumber: number;
    prUrl: string;
    linearIssueId: string;
    linearTeamId: string;
  }): Promise<void> {
    // 1. Verify PR is merged
    // 2. Update Linear issue to Done status (via statusMapper)
    // 3. Create SyncEvent for the status update
    // 4. Emit sync event
  }
}
```

#### `src/features/providers/merge-detection.service.spec.ts`

### MVP: Manual refresh via REST endpoint

```typescript
// POST /tasks/:id/pr/check-merge
// - Fetches PR status from GitHub
// - If merged, triggers Linear completion sync
// - Returns merge state
```

### Hardened path (documented for later)

- Local webhook tunnel (e.g., smee.io, ngrok)
- GitHub webhook with HMAC verification
- Event filtering (only pull_request.closed/merged)
- Rate limiting and replay protection

### TSH-106: AC checklist

- [ ] MVP merge detection via polling/manual refresh implemented
- [ ] `POST /tasks/:id/pr/check-merge` endpoint exists
- [ ] Linear issue updates to configured Done status after merge
- [ ] Idempotent: no duplicate status updates on re-check
- [ ] Closed-unmerged PR does not mark Linear issue Done
- [ ] Offline behavior: action returns visible warning
- [ ] Hardened webhook path documented
- [ ] All tests pass
- [ ] Branch merges to main

---

## TSH-109 — Mobile sync UI + provider errors

**Branch:** `agent/TSH-109-mobile-sync-ui`

### TSH-109: Goal

Add Phase 4 UI elements to the controller: linked task detail, sync status panel, new approval cards (commit, push, PR, Linear), and provider error display. Preserve replay/reconnect deduplication.

### TSH-109: Files to create

#### `controller/components/sync-status-panel.tsx`

```typescript
// Displays SyncEvent records for the current task
// Props: syncEvents: SyncEvent[]
// Shows: provider icon, action name, status badge, external ID/URL link, timestamp
// Status colors: succeeded=green, failed=red, retryable=amber, pending=blue, skipped=gray
```

#### `controller/components/issue-link-card.tsx`

```typescript
// Displays linked issue info
// Shows: provider icon (GitHub/Linear), issue key, title, deep link
// Compact for mobile
```

#### `controller/components/provider-error-card.tsx`

```typescript
// Displays provider errors with recovery text
// Shows: provider, action, error category, human-readable message
// Actionable: "Check your GitHub token" or "Retry from sync panel"
```

### TSH-109: Files to modify

#### `controller/app/tasks/[id]/page.tsx` — add Phase 4 sections

- Issue link card in header
- Sync status panel in card area (after approvals, before logs)
- Commit/push/PR approval cards (handled by existing approval card logic)
- Provider error display

#### `controller/features/tasks/use-task-detail.ts` — add

- `syncEvents` state
- `onSyncEvent` handler for WS events
- `handleCheckMerge` action
- Integration with `seenEvents` dedupe set

#### `controller/lib/api.ts` — add

- `SyncEvent` type
- `searchIssues()` function
- `requestCommit()`, `executeCommit()`
- `requestPush()`, `executePush()`
- `requestPr()`, `executePr()`
- `checkMerge()`

#### `controller/lib/use-socket.ts` — add handler

- `onSyncEvent` callback

### Replay Contract (Critical)

All Phase 4 UI events must follow the same pattern:

1. WS handler emits `onSyncEvent` → upsert sync event to state
2. Replay handler catches `sync.*` named events → same upsert
3. `seenEvents` dedupe set prevents duplicate cards on reconnect
4. GET /tasks/:id returns syncEvents in TaskDetails response

### TSH-109: AC checklist

- [ ] Linked issue card shows provider icon, key, title, deep link
- [ ] Sync status panel shows current and historical sync actions
- [ ] Approval cards for commit/push/PR/Linear are clear on mobile
- [ ] Provider errors show actionable recovery text
- [ ] Replay/reconnect preserves correct UI state without duplicates
- [ ] All existing tests still pass
- [ ] Branch merges to main

---

## TSH-110 — Provider test matrix + token-gated e2e

**Branch:** `agent/TSH-110-provider-test-matrix`

### TSH-110: Goal

Complete test coverage for all Phase 4 provider code. Unit tests with mocks, integration tests for the issue-to-PR happy path, and token-gated real-provider e2e tests.

### TSH-110: Files to create

#### `test/provider-e2e.spec.ts` (token-gated e2e)

```typescript
describe('Provider E2E (token-gated)', () => {
  beforeAll(() => {
    if (!process.env.ARC_GITHUB_TOKEN || !process.env.ARC_LINEAR_API_KEY) {
      return; // test will be skipped
    }
  });

  // Test: GitHub issue search
  // Test: Linear issue search
  // Test: GitHub branch creation (with cleanup)
  // Test: Draft PR creation + cleanup
  // Test: Linear attachment creation
});
```

#### `test/fixtures/github-issue.json`

```json
{
  "id": 1,
  "number": 5,
  "title": "Test issue",
  "state": "open",
  "url": "https://github.com/owner/repo/issues/5",
  "labels": ["bug"],
  "body": "Test body",
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-01-01T00:00:00Z"
}
```

#### `test/fixtures/github-pr.json`

#### `test/fixtures/linear-issue.json`

#### `test/fixtures/linear-workflow-states.json`

#### `test/fixtures/provider-errors.json`

```json
{
  "auth_failed": { "status": 401, "message": "Bad credentials" },
  "rate_limited": { "status": 403, "message": "API rate limit exceeded" },
  "not_found": { "status": 404, "message": "Not Found" },
  "conflict": { "status": 409, "message": "Already exists" }
}
```

### Existing test enhancements

#### `src/features/sync/sync-event.service.spec.ts` — add

- Duplicate suppression test
- State transition illegal transition test

#### `src/features/worktrees/git-worktree.service.spec.ts` — add

- Branch name with issue key
- Collision handling
- Dirty repo guard

#### `src/features/providers/github-provider.spec.ts` — add

- Auth failure normalization
- Rate limit error normalization
- Search returns empty array on no results

#### `src/features/providers/linear-provider.spec.ts` — add

- Auth failure normalization
- Workflow state discovery
- Missing state fallback

### TSH-110: AC checklist

- [ ] Unit tests cover all provider adapter methods
- [ ] Unit tests cover SyncEvent state transitions
- [ ] Integration tests cover issue-to-PR happy path with mocks
- [ ] Real-provider e2e tests are gated and skipped when config absent
- [ ] Fixture payloads are checked in and documented
- [ ] `pnpm test` passes without provider config
- [ ] Branch merges to main

---

## Dependency graph

```text
TSH-107 (provider interfaces)
  └─ TSH-99 (SyncEvent model)
       ├─ TSH-97 (GitHub provider) ◄── depends on TSH-99
       ├─ TSH-98 (Linear provider)  ◄── depends on TSH-99
       │
       ├─ TSH-100 (issue picker) ◄── depends on TSH-97, TSH-98
       ├─ TSH-101 (branch naming) ◄── depends on TSH-100
       │
       ├─ TSH-108 (sync orchestrator) ◄── depends on TSH-99, TSH-97, TSH-98
       │
       ├─ TSH-102 (commit) ◄── depends on TSH-101, TSH-108
       ├─ TSH-103 (push)   ◄── depends on TSH-102, TSH-108
       ├─ TSH-104 (draft PR) ◄── depends on TSH-103, TSH-108, TSH-97
       ├─ TSH-105 (cross-ref) ◄── depends on TSH-104, TSH-98, TSH-108
       └─ TSH-106 (merge detection) ◄── depends on TSH-105, TSH-97, TSH-98
       
TSH-109 (mobile UI) ◄── depends on TSH-100, TSH-102, TSH-103, TSH-104, TSH-105, TSH-108
TSH-110 (test matrix) ◄── depends on ALL (final pass)
```

## Branch naming

All branches: `agent/TSH-{NUMBER}-{kebab-slug}`

## Validation commands per branch

```bash
pnpm test                          # Unit tests
pnpm test:e2e                      # Integration/e2e tests
pnpm typecheck                     # TypeScript check
pnpm build                         # Full build
cd controller && node_modules/.bin/tsc --noEmit  # Controller typecheck
```
