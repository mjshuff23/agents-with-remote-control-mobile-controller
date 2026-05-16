# System Diagrams

Source-of-truth diagrams for the project, authored as Mermaid so they render natively on GitHub and in Notion. Each one has a corresponding (planned) Figma version once the seat is upgraded.

---

## 1. System Architecture

```mermaid
flowchart LR
  subgraph Mobile["Phone / Web Controller (PWA)"]
    UI["Controller UI<br/>Dashboard · Tasks · Approvals · Diffs · Tests · Logs"]
  end

  TS["Tailscale private overlay<br/>Phase 4.5 daily remote path"]

  subgraph Host["Local Host (Windows + WSL2)"]
    subgraph Orch["Local Orchestrator (NestJS)"]
      API["REST API"]
      WS["WebSocket Gateway"]
      Tasks["TaskModule"]
      Sessions["AgentSessionModule"]
      Adapters["AgentAdapterModule"]
      Git["GitModule (worktrees)"]
      Policy["PolicyModule"]
      Approvals["ApprovalsModule"]
      Notify["NotificationModule"]
      Sync["SyncModule"]
      Audit["AuditLogModule"]
      DB[("SQLite (MVP)")]
    end

    subgraph WSL["WSL2 Runtime"]
      Codex["Codex CLI"]
      Claude["Claude Code CLI<br/>(Phase 6)"]
      Gemini["Gemini CLI<br/>(Phase 6)"]
      WT["Repo Worktrees<br/>../arc-task-NNN"]
    end
  end

  subgraph External["External Sync Layer (Phase 4+)"]
    GH["GitHub<br/>Issues · PRs · Repo"]
    LN["Linear<br/>Project · Issues"]
    FG["Figma / FigJam<br/>Diagrams"]
    NT["Notion<br/>Strategy Docs"]
    MCP["MCP Servers<br/>Tools as data"]
  end

  UI <-->|"REST + WebSocket"| TS
  TS <-->|"private 100.x.y.z / MagicDNS"| WS
  TS -->|"private 100.x.y.z / MagicDNS"| API
  API --> Tasks
  WS --> Sessions
  Tasks --> Sessions
  Sessions --> Adapters
  Adapters --> Codex
  Adapters --> Claude
  Adapters --> Gemini
  Codex --> WT
  Claude --> WT
  Gemini --> WT
  Git --> WT
  Sessions --> Policy
  Sessions --> Approvals
  Approvals --> Notify
  Notify -.->|"push / WS event"| UI
  Sessions --> Audit
  Tasks --> DB
  Sessions --> DB
  Policy --> DB
  Approvals --> DB
  Audit --> DB
  Sync -.-> GH
  Sync -.-> LN
  Sync -.-> FG
  Sync -.-> NT
  Sync -.-> MCP
```

Phone and orchestrator are bidirectional over WebSocket (live logs, approval prompts, diff/test summaries), with REST for one-shot commands. Phase 3 runs Codex inside a task-scoped worktree and leaves external sync dashed/deferred.

---

## 2. Task Lifecycle Flow

```mermaid
flowchart TD
  Start(["User starts task on phone"]) --> Create["POST /tasks<br/>{prompt, agent, repo}"]
  Create --> Worktree["GitModule:<br/>worktree add + branch"]
  Worktree --> Launch["AgentAdapter.startTask()"]
  Launch --> Stream["Stream stdout/stderr<br/>→ AgentLog + WS events"]
  Stream --> Decision{"Agent action<br/>or review request?"}
  Decision -->|"SAFE"| Stream
  Decision -->|"NEEDS APPROVAL"| Prompt["Notify phone<br/>ApprovalRequest pending"]
  Decision -->|"BLOCKED"| Refuse["Refuse + audit"]
  Refuse --> Stream
  Prompt --> Decide{"Human decision"}
  Decide -->|"approved"| Forward["Forward to agent"]
  Decide -->|"denied"| Forward
  Decide -->|"denied with msg"| Forward
  Decide -->|"expired"| Refuse
  Forward --> Stream
  Stream --> Done{"Agent done?"}
  Done -->|"no"| Decision
  Done -->|"yes"| Summary["GitChangeSummary<br/>+ TestRunSummary"]
  Summary --> End(["Task complete<br/>local review only"])
```

---

## 3. Approval Gate State Machine

```mermaid
stateDiagram-v2
  [*] --> Classified
  Classified --> SafeAllowed: SAFE rule matched
  Classified --> Pending: NEEDS_APPROVAL
  Classified --> Refused: BLOCKED rule matched

  SafeAllowed --> [*]: log only
  Refused --> [*]: log security event

  Pending --> Approved: human taps approve
  Pending --> Denied: human taps deny
  Pending --> DeniedWithMessage: human types reason
  Pending --> Expired: timeout (default deny)

  Approved --> Executed: forward to agent
  Denied --> Acknowledged: forward 'denied' to agent
  DeniedWithMessage --> Acknowledged: forward reason to agent
  Expired --> Acknowledged: forward 'denied (expired)' to agent

  Executed --> [*]
  Acknowledged --> [*]
```

Expired approvals are **denials**, never auto-allows. See [`SAFETY.md`](SAFETY.md#failure-modes-worth-naming).

---

## 4. Database ERD

```mermaid
erDiagram
  Task ||--o{ AgentSession : "has"
  Task ||--o{ ApprovalRequest : "produces"
  Task ||--o{ GitChangeSummary : "snapshots"
  Task ||--o{ AuditLog : "audits"
  Task ||--o{ TestRunSummary : "tests"
  AgentSession ||--o{ AgentLog : "writes"
  AgentSession ||--o{ ApprovalRequest : "raises"
  AgentSession ||--o{ AuditLog : "audits"
  AgentSession ||--o{ GitChangeSummary : "snapshots"
  AgentSession ||--o{ TestRunSummary : "tests"
  ApprovalRequest ||--o{ AuditLog : "records"

  Task {
    uuid id PK
    string title
    text prompt
    string status
    string selectedAgent
    string repoPath
    string worktreePath
    string branchName
    string baseRef
    string baseCommit
    string approvalMode
    datetime createdAt
    datetime updatedAt
  }

  AgentSession {
    uuid id PK
    uuid taskId FK
    string agentName
    string externalSessionId
    string status
    datetime startedAt
    datetime completedAt
  }

  AgentLog {
    uuid id PK
    uuid sessionId FK
    string type
    text content
    datetime createdAt
  }

  ApprovalRequest {
    uuid id PK
    uuid taskId FK
    uuid sessionId FK
    string actionType
    text description
    string riskLevel
    string status
    string ruleMatched
    string decision
    datetime requestedAt
    datetime resolvedAt
    datetime expiresAt
    text resolutionMessage
  }

  AuditLog {
    uuid id PK
    uuid taskId FK
    uuid sessionId FK
    uuid approvalRequestId FK
    string kind
    string actionType
    string riskLevel
    string ruleMatched
    string decision
    text message
    text metadataJson
    datetime createdAt
  }

  GitChangeSummary {
    uuid id PK
    uuid taskId FK
    int filesChanged
    int insertions
    int deletions
    int addedCount
    int modifiedCount
    int deletedCount
    int renamedCount
    text riskFlagsJson
    text topFilesJson
    datetime createdAt
  }

  TestRunSummary {
    uuid id PK
    uuid taskId FK
    uuid sessionId FK
    string commandId
    string commandJson
    string status
    int exitCode
    text highlightsJson
    datetime startedAt
    datetime completedAt
    datetime createdAt
  }
```

---

## 5. Happy Path

```mermaid
sequenceDiagram
  autonumber
  participant U as User (phone)
  participant C as Controller UI
  participant O as Orchestrator
  participant G as GitModule
  participant A as Agent (Codex)
  participant P as Policy/Approvals

  U->>C: New task: "Add pagination to /users"
  C->>O: POST /tasks
  O->>G: worktree add ../arc-task-042
  G-->>O: worktreePath, branchName
  O->>A: startTask(prompt, worktree)
  A-->>O: session started
  O-->>C: WS task.started
  loop until done
    A-->>O: stdout / stderr
    O-->>C: WS agent.log
  end
  A->>O: ARC_ACTION_REQUEST(fs.write_patch)
  O->>P: classify -> NEEDS_APPROVAL
  P-->>O: ApprovalRequest pending
  O-->>C: WS approval.requested
  C-->>U: Approval card
  U->>C: Approve
  C->>O: POST /approvals/:id/approve
  O->>A: ARC_APPROVAL approved
  A-->>O: task complete
  O->>G: git diff summary
  O-->>C: WS diff.summary
  O->>O: run configured test command
  O-->>C: WS test.started / test.log / test.completed
  O-->>C: WS task.idle / task.completed
  C-->>U: Local review ready
```

---

## 6. Bad Paths

```mermaid
flowchart TD
  Task["Active task"] --> P{"Failure mode"}
  P --> Dangerous["Agent requests<br/>BLOCKED action<br/>(force push, read .env)"]
  P --> TestFail["Tests fail"]
  P --> Hang["CLI process hangs<br/>or unresponsive"]
  P --> Conflict["Worktree conflict<br/>(merge / dirty state)"]
  P --> Disconnect["Phone disconnects<br/>during approval window"]

  Dangerous --> Refuse["Refuse · audit · alert"]
  TestFail --> Surface["Surface failure to controller<br/>agent stops, awaits steering"]
  Hang --> Heartbeat{"Heartbeat lost?"}
  Heartbeat -->|"yes"| Reap["Reap process<br/>mark session failed"]
  Heartbeat -->|"no"| Wait["Wait + show 'thinking'"]
  Conflict --> Pause["Pause agent<br/>request human merge decision"]
  Disconnect --> Hold["Hold approval pending<br/>expire after configurable window"]
  Hold --> Expired["Mark expired = denied"]

  Refuse --> Resume["Agent resumes<br/>(or stops on policy)"]
  Surface --> Resume
  Reap --> Resume
  Wait --> Resume
  Pause --> Resume
  Expired --> Resume
```

Default behavior across all bad paths: **fail safe, log everything, surface to the human**. Never silently continue past a failure.

---

## 7. Alternatives Considered

```mermaid
flowchart LR
  Goal["Remote control of<br/>local AI coding agents"]

  Goal --> A1["Direct VS Code<br/>chat extension automation"]
  Goal --> A2["VS Code extension<br/>as primary UI"]
  Goal --> A3["CLI-first orchestrator +<br/>mobile/web controller<br/>(chosen)"]
  Goal --> A4["Telegram / Discord<br/>bot prototype"]
  Goal --> A5["Full custom PWA<br/>from day 1"]
  Goal --> A6["Long polling for<br/>controller transport"]
  Goal --> A7["SSE for<br/>controller transport"]
  Goal --> A8["WebSockets for<br/>controller transport (chosen)"]

  A1 -->|"❌ rejected"| R1["GUI-coupled · no stable<br/>protocol · fragile"]
  A2 -->|"❌ rejected"| R2["Locks UX to one editor<br/>and one machine"]
  A3 -->|"✅ chosen"| R3["Stable contract · scriptable ·<br/>any frontend can drive it"]
  A4 -->|"⚠️ maybe"| R4["Useful prototype,<br/>but ties to 3rd party platform"]
  A5 -->|"⏸ deferred"| R5["Premature; PWA wraps<br/>are Phase 6 work"]
  A6 -->|"❌ rejected"| R6["Client-initiated, not full duplex"]
  A7 -->|"❌ rejected"| R7["One-way (server→client only)"]
  A8 -->|"✅ chosen"| R8["Full duplex · server push ·<br/>browser native"]

  classDef chosen fill:#DCFCE7,stroke:#15803D,color:#052E16
  classDef rejected fill:#FEE2E2,stroke:#B91C1C,color:#450A0A
  classDef maybe fill:#FEF3C7,stroke:#B45309,color:#451A03
  classDef deferred fill:#E5E7EB,stroke:#374151,color:#0F172A
  class A3,A8,R3,R8 chosen
  class A1,A2,A6,A7,R1,R2,R6,R7 rejected
  class A4,R4 maybe
  class A5,R5 deferred
```

---

## Notes for the Figma upgrade

When the Figma seat upgrades to editor:

1. Run `figma:figma-generate-diagram` against the Mermaid above for diagrams 1-6.
2. Diagram 7 (Alternatives Considered) is better as a hand-laid FigJam canvas with rich annotations than as a generated diagram.
3. The diagrams here remain canonical. Figma versions are *companions* — the source of truth lives in version control alongside the code.
