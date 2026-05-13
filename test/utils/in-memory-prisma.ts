type Row = Record<string, unknown>;

interface Delegate {
  create: jest.Mock;
  update: jest.Mock;
  findUnique: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
}

export interface InMemoryPrisma {
  task: Delegate;
  agentSession: Delegate;
  agentLog: Delegate;
  approvalRequest: Delegate;
  auditLog: Delegate;
  gitChangeSummary: Delegate;
  testRunSummary: Delegate;
  sessionCheckpoint: Delegate;
  taskEvent: Delegate;
  $connect: jest.Mock;
  $disconnect: jest.Mock;
  $transaction: jest.Mock;
}

/**
 * Return the current timestamp for row creation/update.
 *
 * @returns The current date.
 */
const now = () => new Date();

/**
 * Generate a random ID with the given prefix for in-memory row keys.
 *
 * @param prefix - String prefix for the generated ID.
 * @returns A string like `"prefix-a1b2c3d4"`.
 */
const randomId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Sort rows by the given field and direction (asc/desc). Returns a new array.
 *
 * @param rows    - Array of row objects to sort.
 * @param orderBy - Record mapping a single field name to sort direction.
 * @returns A new sorted array (does not mutate the original).
 */
const orderRows = <T extends Row>(rows: T[], orderBy?: Record<string, 'asc' | 'desc'>): T[] => {
  if (!orderBy) {
    return [...rows];
  }
  const entries = Object.entries(orderBy);
  if (entries.length === 0) {
    return [...rows];
  }
  const [[field, direction]] = entries;
  return [...rows].sort((a, b) => {
    const left = a[field] as Date | number | string;
    const right = b[field] as Date | number | string;
    const result = left > right ? 1 : left < right ? -1 : 0;
    return direction === 'desc' ? -result : result;
  });
};

/**
 * Check whether a row matches a Prisma-style where clause.
 * Supports: exact match, `in`, `equals`, `gt`, `gte`, `lt`, `lte`.
 *
 * @param row   - The row to test.
 * @param where - Prisma-style where conditions, or `undefined` to match all.
 * @returns `true` if the row matches all conditions, `false` otherwise.
 * @throws If an unsupported operator is encountered.
 */
const matchesWhere = (row: Row, where?: Row): boolean => {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, value]) => {
    const rowValue = row[key];

    if (value === null || typeof value !== 'object') {
      return rowValue === value;
    }

    if (value instanceof Date) {
      const rowDate = new Date(rowValue as string | number | Date);
      return rowDate.getTime() === value.getTime();
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

    if ('gt' in value) {
      const threshold = (value as { gt: number | Date | string }).gt;
      return (rowValue as number | Date | string) > threshold;
    }

    if ('gte' in value) {
      const threshold = (value as { gte: number | Date | string }).gte;
      return (rowValue as number | Date | string) >= threshold;
    }

    if ('lt' in value) {
      const threshold = (value as { lt: number | Date | string }).lt;
      return (rowValue as number | Date | string) < threshold;
    }

    if ('lte' in value) {
      const threshold = (value as { lte: number | Date | string }).lte;
      return (rowValue as number | Date | string) <= threshold;
    }

    throw new Error(`Unsupported where condition for "${key}": ${JSON.stringify(value)}`);
  });
};

/**
 * Create a fully mocked in-memory Prisma client for testing.
 * Each model delegate stores rows in an isolated array and supports
 * create, update, findUnique, findFirst, and findMany operations.
 *
 * @returns A mock Prisma client with delegates for all models
 *          (`task`, `agentSession`, `agentLog`, `approvalRequest`,
 *           `auditLog`, `gitChangeSummary`, `testRunSummary`, `taskEvent`)
 *          plus stubbed `$connect`, `$disconnect`, and `$transaction`.
 */
export const createInMemoryPrisma = (): InMemoryPrisma => {
  const tasks: Row[] = [];
  const sessions: Row[] = [];
  const logs: Row[] = [];
  const approvals: Row[] = [];
  const auditLogs: Row[] = [];
  const changeSummaries: Row[] = [];
  const testRuns: Row[] = [];
  const checkpoints: Row[] = [];
  const taskEvents: Row[] = [];

  /**
   * Create a mock Prisma delegate that operates on the given in-memory row array.
   * Supports create, update, findUnique, findFirst, and findMany.
   *
   * @param rows   - The backing array for row storage.
   * @param prefix - Prefix for auto-generated row IDs.
   * @returns An object with `create`, `update`, `findUnique`, `findFirst`,
   *          and `findMany` mock functions.
   */
  const createDelegate = (rows: Row[], prefix: string) => ({
    /**
     * Insert a new row with auto-generated id and timestamps.
     *
     * @param data - The row data to insert.
     * @returns The created row with id, createdAt, and updatedAt.
     */
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
    /**
     * Update a matching row, throwing if not found.
     *
     * @param where - Prisma-style where clause to match the row.
     * @param data  - The row data to merge in.
     * @returns The updated row.
     * @throws If no row matches the where clause.
     */
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matchesWhere(candidate, where));
      if (!row) {
        throw new Error(`${prefix} not found`);
      }
      Object.assign(row, data, { updatedAt: now() });
      return row;
    }),
    /**
     * Find a single row matching the where clause, or null.
     *
     * @param where - Prisma-style where clause.
     * @returns The matching row, or `null` if not found.
     */
    findUnique: jest.fn(async ({ where }: { where: Row }) =>
      rows.find((candidate) => matchesWhere(candidate, where)) ?? null
    ),
    /**
     * Find the first matching row, optionally ordered.
     *
     * @param where   - Optional Prisma-style where clause.
     * @param orderBy - Optional sort specification.
     * @returns The first matching row, or `null`.
     */
    findFirst: jest.fn(async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'> } = {}) =>
      orderRows(rows.filter((candidate) => matchesWhere(candidate, where)), orderBy)[0] ?? null
    ),
    /**
     * Find all matching rows, optionally ordered and limited.
     *
     * @param where   - Optional Prisma-style where clause.
     * @param orderBy - Optional sort specification.
     * @param take    - Maximum number of rows to return.
     * @returns Array of matching rows (empty if none).
     */
    findMany: jest.fn(async ({ where, orderBy, take }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'>; take?: number } = {}) => {
      const ordered = orderRows(rows.filter((candidate) => matchesWhere(candidate, where)), orderBy);
      return typeof take === 'number' && take > 0 ? ordered.slice(0, take) : ordered;
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
    sessionCheckpoint: createDelegate(checkpoints, 'chkpt'),
    taskEvent: createDelegate(taskEvents, 'event'),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    /**
     * Run a callback within a mock transaction using fresh delegates.
     *
     * @param callback - Function receiving a transactional client.
     * @returns The return value of the callback.
     */
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      task: createDelegate(tasks, 'task'),
      agentSession: createDelegate(sessions, 'session'),
      agentLog: createDelegate(logs, 'log'),
      approvalRequest: createDelegate(approvals, 'approval'),
      auditLog: createDelegate(auditLogs, 'audit'),
      gitChangeSummary: createDelegate(changeSummaries, 'summary'),
      testRunSummary: createDelegate(testRuns, 'testRun'),
      sessionCheckpoint: createDelegate(checkpoints, 'chkpt'),
      taskEvent: createDelegate(taskEvents, 'event')
    }))
  };
};
