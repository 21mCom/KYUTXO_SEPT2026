export type ProtectedPrimaryKey = string | number;

export interface MigrationRow {
  id: ProtectedPrimaryKey;
  row: unknown;
}

export interface MigrationAttachment {
  id: string;
  size?: number;
  stream: AsyncIterable<Uint8Array>;
}

export interface MigrationSourceAdapter {
  estimateBytes(): Promise<number>;
  rows(
    table: string,
    options: { batchSize: number },
  ): AsyncIterable<MigrationRow[]>;
  attachments(): AsyncIterable<MigrationAttachment>;
  authenticatePreflight(password: string): Promise<boolean>;
  freeze(options: { sessionId: string }): Promise<boolean>;
  thaw(options: {
    sessionId?: string;
    generation?: string;
    reason: string;
  }): Promise<boolean>;
  removeSource(): Promise<boolean>;
  plaintextRemaining(): Promise<boolean>;
}

export interface MigrationControllerOptions {
  root: string;
  sourceAdapter?: MigrationSourceAdapter | null;
  referenceVerifier?: ((snapshot: unknown) => Promise<boolean>) | null;
  sourceReferenceVerifier?: ((snapshot: unknown) => Promise<boolean>) | null;
  protectedReferenceVerifier?: ((snapshot: unknown) => Promise<boolean>) | null;
  diskSpace?: (root: string) => Promise<number>;
  testOnlyFaultInjector?: ((phase: string) => Promise<void>) | null;
}

export interface MigrationStatus {
  phase: string;
  frozen: boolean;
  session: string | null;
}

export class ProtectedVaultMigrationController {
  constructor(options: MigrationControllerOptions);
  status(): MigrationStatus;
  operationAllowed(operation: string): boolean;
  migrate(options: { password: string }): Promise<{
    baseline: unknown;
    active: unknown;
    generation: string;
  }>;
  recover(options?: {
    password?: string;
    resumeContext?: {
      sourceAdapter: MigrationSourceAdapter;
      authenticateAndFreeze(options: {
        password: string;
        generation: string;
      }): Promise<boolean>;
      authenticateSource?(options: {
        password?: string;
        generation: string;
      }): Promise<boolean>;
    };
  }): Promise<{
    recovered: boolean;
    action: string;
  }>;
}

export const ProtectedVaultMigration: typeof ProtectedVaultMigrationController;
export const PROTECTED_TABLES: readonly string[];