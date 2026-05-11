type Row = Record<string, unknown>;

const now = () => new Date();

const randomId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

const orderRows = <T extends Row>(rows: T[], orderBy?: Record<string, 'asc' | 'desc'>): T[] => {
  if (!orderBy) {
    return rows;
  }
  const [[field, direction]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const left = a[field] as Date | number | string;
    const right = b[field] as Date | number | string;
    const result = left > right ? 1 : left < right ? -1 : 0;
    return direction === 'desc' ? -result : result;
  });
};

const matchesWhere = (row: Row, where?: Row): boolean => {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, value]) => {
    const rowValue = row[key];

    if (value === null || typeof value !== 'object') {
      return rowValue === value;
    }

    if ('in' in value) {
      if (!Array.isArray(value.in)) {
        throw new Error(`Unsupported where condition for "${key}": "in" operator requires an array`);
      }
      return value.in.includes(rowValue);
    }

    if ('equals' in value) {
      return rowValue === value.equals;
    }

    throw new Error(`Unsupported where condition for "${key}": ${JSON.stringify(value)}`);
  });
};

export const createInMemoryPrisma = () => {
  const tasks: Row[] = [];
  const sessions: Row[] = [];
  const logs: Row[] = [];
  const approvals: Row[] = [];
  const auditLogs: Row[] = [];
  const changeSummaries: Row[] = [];
  const testRuns: Row[] = [];

  const createDelegate = (rows: Row[], prefix: string) => ({
    create: jest.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: randomId(prefix),
        createdAt: now(),
        updatedAt: now(),
        ...data
      };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matchesWhere(candidate, where));
      if (!row) {
        throw new Error(`${prefix} not found`);
      }
      Object.assign(row, data, { updatedAt: now() });
      return row;
    }),
    findUnique: jest.fn(async ({ where }: { where: Row }) =>
      rows.find((candidate) => matchesWhere(candidate, where)) ?? null
    ),
    findFirst: jest.fn(async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'> } = {}) =>
      orderRows(rows.filter((candidate) => matchesWhere(candidate, where)), orderBy)[0] ?? null
    ),
    findMany: jest.fn(async ({ where, orderBy, take }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'>; take?: number } = {}) => {
      const ordered = orderRows(rows.filter((candidate) => matchesWhere(candidate, where)), orderBy);
      return typeof take === 'number' ? ordered.slice(0, take) : ordered;
    })
  });

  return {
    task: createDelegate(tasks, 'task'),
    agentSession: createDelegate(sessions, 'session'),
    agentLog: createDelegate(logs, 'log'),
    approvalRequest: createDelegate(approvals, 'approval'),
    auditLog: createDelegate(auditLogs, 'audit'),
    gitChangeSummary: createDelegate(changeSummaries, 'summary'),
    testRunSummary: createDelegate(testRuns, 'testRun'),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      task: createDelegate(tasks, 'task'),
      agentSession: createDelegate(sessions, 'session'),
      agentLog: createDelegate(logs, 'log'),
      approvalRequest: createDelegate(approvals, 'approval'),
      auditLog: createDelegate(auditLogs, 'audit'),
      gitChangeSummary: createDelegate(changeSummaries, 'summary'),
      testRunSummary: createDelegate(testRuns, 'testRun')
    }))
  };
};
