# Figma Companion Diagrams

These diagrams mirror the FigJam companion boards created for the project. The canonical architecture diagrams still live in [`docs/diagrams.md`](./diagrams.md); this file preserves the Figma companion set as version-controlled Mermaid so the repository remains the source of truth.

## FigJam Boards

- [ARC System Architecture](https://www.figma.com/board/UvKfcrygoArngHuPJOFH7z?utm_source=chatgpt&utm_content=edit_in_figjam&oai_id=v1%2Ftz6jqBBL9G8gridydDslE8NPS8QSNMmS7Z2yK53WgDre51jArgu3Ma&request_id=6190b3af-bd4c-4244-9e3c-d8c50fe0b1cb)
- [ARC Phase 1 UX Task Flow](https://www.figma.com/board/glUcIHkltNz5A0xd2qkmW4?utm_source=chatgpt&utm_content=edit_in_figjam&oai_id=v1%2Ftz6jqBBL9G8gridydDslE8NPS8QSNMmS7Z2yK53WgDre51jArgu3Ma&request_id=846303bd-6df7-4bb6-9595-35cff173dcda)
- [ARC Implementation Phases](https://www.figma.com/board/nRqdCuFj2xtaJLXyBRvLK7?utm_source=chatgpt&utm_content=edit_in_figjam&oai_id=v1%2Ftz6jqBBL9G8gridydDslE8NPS8QSNMmS7Z2yK53WgDre51jArgu3Ma&request_id=fa2b8b0a-c61f-4a79-bdda-86bdf13916f3)
- [ARC Approval and Bad Paths](https://www.figma.com/board/SbFjimirwqbxSEmjnArRcD?utm_source=chatgpt&utm_content=edit_in_figjam&oai_id=v1%2Ftz6jqBBL9G8gridydDslE8NPS8QSNMmS7Z2yK53WgDre51jArgu3Ma&request_id=a68f41bb-b6b0-4e01-8030-5a7c998f007a)

---

## 1. ARC System Architecture

```mermaid
flowchart LR
  subgraph Mobile["Phone / Web Controller"]
    UI["Mobile UI: dashboard, task form, logs, approvals"]
  end

  subgraph Host["Local Host: Windows plus WSL2"]
    API["NestJS REST API"]
    DB[("SQLite MVP")]
    Tasks["Task Module"]
    Sessions["Agent Session Module"]
    Adapter["Agent Adapter Interface"]
    Logs["Agent Log Store"]
    Codex["Codex CLI in WSL2"]
  end

  subgraph Later["Later phases"]
    WS["WebSocket Gateway"]
    Git["Git Worktrees"]
    Gate["Approval Gate"]
    Sync["GitHub, Linear, Notion, Figma, MCP Sync"]
  end

  UI -->|"Phase 1 test via REST client"| API
  API --> Tasks
  Tasks --> Sessions
  Sessions --> Adapter
  Adapter --> Codex
  Sessions --> Logs
  Tasks --> DB
  Sessions --> DB
  Logs --> DB
  API -. "Phase 2" .-> WS
  Sessions -. "Phase 3" .-> Gate
  Sessions -. "Phase 3" .-> Git
  Tasks -. "Phase 4 plus" .-> Sync
```

---

## 2. ARC Phase 1 UX Task Flow

```mermaid
flowchart TD
  Start(["User opens controller or REST client"])
  Form["New Task input: prompt and agent equals codex"]
  Submit["POST /tasks"]
  Persist["Create Task and AgentSession rows"]
  Launch["Start CodexAdapter"]
  Spawn["node-pty launches Codex CLI in WSL2"]
  Log["Capture stdout and stderr"]
  Store["Persist AgentLog rows"]
  Inspect["GET /tasks/:id shows task, session, log tail"]
  Done{"Agent process ended?"}
  Summary["Return stored session and summary"]
  Stop["POST /tasks/:id/stop optional"]
  Error["Mark session failed and keep logs"]

  Start --> Form --> Submit --> Persist --> Launch --> Spawn --> Log --> Store --> Inspect --> Done
  Done -->|"yes"| Summary
  Done -->|"no, still running"| Log
  Inspect -->|"user stops"| Stop --> Summary
  Spawn -->|"CLI error"| Error --> Summary
```

---

## 3. ARC Implementation Phases

```mermaid
flowchart LR
  P1["Phase 1: Local orchestrator plus single-agent CLI runner"]
  P2["Phase 2: Mobile/web controller plus live session UI"]
  P3["Phase 3: Worktrees, approval gates, diffs, tests"]
  P4["Phase 4: GitHub plus Linear sync"]
  P5["Phase 5: Notion, Figma, controlled MCP sync"]
  P6["Phase 6: Multi-agent review and advanced automation"]

  M1["First milestone: prompt launches Codex in WSL2, logs persist, summary returns"]
  M2["Usable from phone"]
  M3["Safe for real coding work"]
  M4["Issue to branch to PR loop"]
  M5["Project knowledge and design sync"]
  M6["Agent review swarm with human final gate"]

  P1 --> P2 --> P3 --> P4 --> P5 --> P6
  P1 --> M1
  P2 --> M2
  P3 --> M3
  P4 --> M4
  P5 --> M5
  P6 --> M6
```

---

## 4. ARC Approval and Bad Paths

```mermaid
flowchart TD
  Agent["Agent requests action"] --> Classify{"Classify risk"}
  Classify -->|"SAFE"| Auto["Auto-allow and log"]
  Classify -->|"NEEDS APPROVAL"| Pending["Create ApprovalRequest pending"]
  Classify -->|"BLOCKED"| Refuse["Refuse, audit, alert"]

  Pending --> Phone["Send approval card to phone"]
  Phone --> Decision{"Human decision"}
  Decision -->|"Approve"| Execute["Forward approval to agent"]
  Decision -->|"Deny"| Deny["Forward denial to agent"]
  Decision -->|"Deny with message"| Steer["Forward steering text"]
  Decision -->|"Timeout"| Expire["Expire equals deny"]

  Execute --> Audit["Append audit event"]
  Deny --> Audit
  Steer --> Audit
  Expire --> Audit
  Refuse --> Audit
  Auto --> Audit

  Audit --> Continue{"Continue or stop task"}
  Continue -->|"continue"| Agent
  Continue -->|"stop"| End(["Task stopped safely"])
```
