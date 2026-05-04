import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import type {
  StoreState,
  Referral,
  Submission,
  Task,
  UserProfile,
  WalletTransaction,
  Withdrawal
} from "./types.js";

const { Pool } = pg;

const emptyState = (): StoreState => ({
  users: [],
  tasks: [],
  submissions: [],
  walletTransactions: [],
  withdrawals: [],
  verificationEvents: [],
  referrals: []
});

export interface NeosenceStore {
  load(): Promise<void>;
  snapshot(): StoreState;
  upsertUser(user: UserProfile): Promise<void>;
  addTask(task: Task): Promise<void>;
  updateTask(task: Task): Promise<void>;
  addSubmission(submission: Submission): Promise<void>;
  updateSubmission(submission: Submission): Promise<void>;
  addTransaction(transaction: WalletTransaction): Promise<void>;
  addWithdrawal(withdrawal: Withdrawal): Promise<void>;
  updateWithdrawal(withdrawal: Withdrawal): Promise<void>;
  addReferral(referral: Referral): Promise<void>;
}

abstract class CachedStore implements NeosenceStore {
  protected state: StoreState = emptyState();
  protected ready = false;

  abstract load(): Promise<void>;
  protected abstract save(): Promise<void>;

  snapshot(): StoreState {
    return structuredClone(this.state);
  }

  async upsertUser(user: UserProfile): Promise<void> {
    const index = this.state.users.findIndex((item) => item.id === user.id);
    if (index >= 0) this.state.users[index] = user;
    else this.state.users.push(user);
    await this.save();
  }

  async addTask(task: Task): Promise<void> {
    this.state.tasks.push(task);
    await this.save();
  }

  async updateTask(task: Task): Promise<void> {
    const index = this.state.tasks.findIndex((item) => item.id === task.id);
    if (index < 0) throw new Error(`Task not found: ${task.id}`);
    this.state.tasks[index] = task;
    await this.save();
  }

  async addSubmission(submission: Submission): Promise<void> {
    this.state.submissions.push(submission);
    await this.save();
  }

  async updateSubmission(submission: Submission): Promise<void> {
    const index = this.state.submissions.findIndex((item) => item.id === submission.id);
    if (index < 0) throw new Error(`Submission not found: ${submission.id}`);
    this.state.submissions[index] = submission;
    await this.save();
  }

  async addTransaction(transaction: WalletTransaction): Promise<void> {
    this.state.walletTransactions.push(transaction);
    await this.save();
  }

  async addWithdrawal(withdrawal: Withdrawal): Promise<void> {
    this.state.withdrawals.push(withdrawal);
    await this.save();
  }

  async updateWithdrawal(withdrawal: Withdrawal): Promise<void> {
    const index = this.state.withdrawals.findIndex((item) => item.id === withdrawal.id);
    if (index < 0) throw new Error(`Withdrawal not found: ${withdrawal.id}`);
    this.state.withdrawals[index] = withdrawal;
    await this.save();
  }

  async addReferral(referral: Referral): Promise<void> {
    this.state.referrals.push(referral);
    await this.save();
  }
}

export class JsonStore extends CachedStore {
  constructor(private readonly filePath: string) {
    super();
  }

  async load(): Promise<void> {
    if (this.ready) return;

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = { ...emptyState(), ...JSON.parse(raw) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await this.save();
    }

    this.ready = true;
  }

  protected async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2));
    await rename(tempPath, this.filePath);
  }
}

export class PostgresStore extends CachedStore {
  private readonly pool: pg.Pool;
  private readonly stateKey = "neosence";

  constructor(databaseUrl: string) {
    super();
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: needsSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined
    });
  }

  async load(): Promise<void> {
    if (this.ready) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const result = await this.pool.query<{ value: StoreState }>(
      "SELECT value FROM app_state WHERE key = $1",
      [this.stateKey]
    );
    if (result.rows[0]) {
      this.state = { ...emptyState(), ...result.rows[0].value };
    } else {
      await this.save();
    }

    this.ready = true;
  }

  protected async save(): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO app_state (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [this.stateKey, JSON.stringify(this.state)]
    );
  }
}

export function createStore(options: { databaseUrl?: string; dataFile: string }): NeosenceStore {
  if (options.databaseUrl) return new PostgresStore(options.databaseUrl);
  return new JsonStore(options.dataFile);
}

function needsSsl(databaseUrl: string): boolean {
  return (
    databaseUrl.includes("railway") ||
    databaseUrl.includes("proxy.rlwy.net") ||
    databaseUrl.includes("neon.tech") ||
    databaseUrl.includes("sslmode=require")
  );
}
