export interface PostgresStoreOptions {
  connectionString: string;
  profile: 'development' | 'ha';
  role: 'collector' | 'query';
  instanceId: string;
  nodeId: string;
  cleanupConnectionString?: string;
  physicalNodes?: { id: string; connectionString: string; cleanupConnectionString: string }[];
  maxConnections?: number;
  maxCleanupConnections?: number;
  poolWaitMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  commitTimeoutMs?: number;
  responseReserveMs?: number;
  cleanupTimeoutMs?: number;
  maxPendingCleanup?: number;
  requireTls?: boolean;
  onIncident?: (incident: { code: string; nodeId: string; pending: number }) => void;
}

export interface MaintenanceOptions {
  prebuildDays?: number;
  batchSize?: number;
  deadlineAtMs?: number;
  lockTimeoutMs?: number;
}

export interface MaintenanceResult {
  acquired: boolean;
  partitionsCreated: number;
  partitionsDropped: number;
  eventsDeleted: number;
  spansDeleted: number;
  spanReceiptsDeleted: number;
  receiptsDeleted: number;
  auditsDeleted: number;
  traceAuditsDeleted: number;
}

export function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid ${name}`);
  return value;
}
