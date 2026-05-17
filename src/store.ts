import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import type {
  AdminAuditEvent,
  AdminMember,
  AdminPanelMessage,
  DepositRequest,
  Dispute,
  GeniLink,
  GeniSettings,
  GeniVisit,
  StoreState,
  Referral,
  Submission,
  SupportTicket,
  Task,
  TelegramInviteLinkRecord,
  TelegramMembershipRecord,
  TrackedChat,
  UserProfile,
  VerificationEvent,
  WalletTransaction,
  Withdrawal
} from "./types.js";

const { Pool } = pg;

const defaultGeniSettings = (): GeniSettings => ({
  profitCpmUsd: 2,
  trafficCostPerVisitUsd: 0,
  plannedVisits: 1000,
  expectedCompletionRate: 60,
  sameIpLimit: 5,
  sameDeviceLimit: 8,
  blockBotUserAgents: true,
  flagDirectFinalHits: true,
  defaultTitle: "Website task",
  defaultInstructions: "Open the link, complete all shortener steps, and wait until the final page loads.",
  updatedAt: new Date(0).toISOString()
});

const emptyState = (): StoreState => ({
  users: [],
  tasks: [],
  submissions: [],
  walletTransactions: [],
  deposits: [],
  withdrawals: [],
  verificationEvents: [],
  referrals: [],
  supportTickets: [],
  disputes: [],
  trackedChats: [],
  telegramInviteLinks: [],
  telegramMemberships: [],
  adminPanelMessages: [],
  adminMembers: [],
  adminAuditEvents: [],
  geniLinks: [],
  geniVisits: [],
  geniSettings: defaultGeniSettings()
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
  addDeposit(deposit: DepositRequest): Promise<void>;
  updateDeposit(deposit: DepositRequest): Promise<void>;
  addWithdrawal(withdrawal: Withdrawal): Promise<void>;
  updateWithdrawal(withdrawal: Withdrawal): Promise<void>;
  addReferral(referral: Referral): Promise<void>;
  addVerificationEvent(event: VerificationEvent): Promise<void>;
  addSupportTicket(ticket: SupportTicket): Promise<void>;
  updateSupportTicket(ticket: SupportTicket): Promise<void>;
  addDispute(dispute: Dispute): Promise<void>;
  updateDispute(dispute: Dispute): Promise<void>;
  upsertTrackedChat(chat: TrackedChat): Promise<void>;
  upsertTelegramInviteLink(link: TelegramInviteLinkRecord): Promise<void>;
  upsertTelegramMembership(membership: TelegramMembershipRecord): Promise<void>;
  upsertAdminPanelMessage(message: AdminPanelMessage): Promise<void>;
  upsertAdminMember(member: AdminMember): Promise<void>;
  addAdminAuditEvent(event: AdminAuditEvent): Promise<void>;
  upsertGeniLink(link: GeniLink): Promise<void>;
  upsertGeniVisit(visit: GeniVisit): Promise<void>;
  updateGeniSettings(settings: GeniSettings): Promise<void>;
  clearGeniVisits(): Promise<void>;
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

  async addDeposit(deposit: DepositRequest): Promise<void> {
    this.state.deposits.push(deposit);
    await this.save();
  }

  async updateDeposit(deposit: DepositRequest): Promise<void> {
    const index = this.state.deposits.findIndex((item) => item.id === deposit.id);
    if (index < 0) throw new Error(`Deposit request not found: ${deposit.id}`);
    this.state.deposits[index] = deposit;
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

  async addVerificationEvent(event: VerificationEvent): Promise<void> {
    this.state.verificationEvents.push(event);
    await this.save();
  }

  async addSupportTicket(ticket: SupportTicket): Promise<void> {
    this.state.supportTickets.push(ticket);
    await this.save();
  }

  async updateSupportTicket(ticket: SupportTicket): Promise<void> {
    const index = this.state.supportTickets.findIndex((item) => item.id === ticket.id);
    if (index < 0) throw new Error(`Support ticket not found: ${ticket.id}`);
    this.state.supportTickets[index] = ticket;
    await this.save();
  }

  async addDispute(dispute: Dispute): Promise<void> {
    this.state.disputes.push(dispute);
    await this.save();
  }

  async updateDispute(dispute: Dispute): Promise<void> {
    const index = this.state.disputes.findIndex((item) => item.id === dispute.id);
    if (index < 0) throw new Error(`Dispute not found: ${dispute.id}`);
    this.state.disputes[index] = dispute;
    await this.save();
  }

  async upsertTrackedChat(chat: TrackedChat): Promise<void> {
    const index = this.state.trackedChats.findIndex((item) => item.id === chat.id);
    if (index >= 0) this.state.trackedChats[index] = chat;
    else this.state.trackedChats.push(chat);
    await this.save();
  }

  async upsertTelegramInviteLink(link: TelegramInviteLinkRecord): Promise<void> {
    const index = this.state.telegramInviteLinks.findIndex((item) => item.id === link.id);
    if (index >= 0) this.state.telegramInviteLinks[index] = link;
    else this.state.telegramInviteLinks.push(link);
    await this.save();
  }

  async upsertTelegramMembership(membership: TelegramMembershipRecord): Promise<void> {
    const index = this.state.telegramMemberships.findIndex((item) => item.id === membership.id);
    if (index >= 0) this.state.telegramMemberships[index] = membership;
    else this.state.telegramMemberships.push(membership);
    await this.save();
  }

  async upsertAdminPanelMessage(message: AdminPanelMessage): Promise<void> {
    const index = this.state.adminPanelMessages.findIndex((item) => item.id === message.id);
    if (index >= 0) this.state.adminPanelMessages[index] = message;
    else this.state.adminPanelMessages.push(message);
    await this.save();
  }

  async upsertAdminMember(member: AdminMember): Promise<void> {
    const index = this.state.adminMembers.findIndex((item) => item.userId === member.userId);
    if (index >= 0) this.state.adminMembers[index] = member;
    else this.state.adminMembers.push(member);
    await this.save();
  }

  async addAdminAuditEvent(event: AdminAuditEvent): Promise<void> {
    this.state.adminAuditEvents.push(event);
    await this.save();
  }

  async upsertGeniLink(link: GeniLink): Promise<void> {
    const index = this.state.geniLinks.findIndex((item) => item.id === link.id);
    if (index >= 0) this.state.geniLinks[index] = link;
    else this.state.geniLinks.push(link);
    await this.save();
  }

  async upsertGeniVisit(visit: GeniVisit): Promise<void> {
    const index = this.state.geniVisits.findIndex((item) => item.id === visit.id);
    if (index >= 0) this.state.geniVisits[index] = visit;
    else this.state.geniVisits.push(visit);
    await this.save();
  }

  async updateGeniSettings(settings: GeniSettings): Promise<void> {
    this.state.geniSettings = settings;
    await this.save();
  }

  async clearGeniVisits(): Promise<void> {
    this.state.geniVisits = [];
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
  private projectionSyncRunning = false;
  private projectionSyncPending = false;

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
    await this.ensureProjectionTables();

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

    this.scheduleProjectionSync();
  }

  private async ensureProjectionTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ns_users (
        id BIGINT PRIMARY KEY,
        mode TEXT NOT NULL,
        language TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        is_banned BOOLEAN NOT NULL,
        raw JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ns_tasks (
        id TEXT PRIMARY KEY,
        buyer_id BIGINT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        verification_type TEXT,
        verification_target TEXT,
        raw JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ns_submissions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_id BIGINT NOT NULL,
        status TEXT NOT NULL,
        raw JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ns_wallet_transactions (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        raw JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ns_verification_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_id BIGINT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        raw JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ns_tracked_chats (
        id BIGINT PRIMARY KEY,
        type TEXT NOT NULL,
        bot_status TEXT NOT NULL,
        can_verify_members BOOLEAN NOT NULL,
        raw JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS ns_tasks_buyer_status_idx ON ns_tasks (buyer_id, status);
      CREATE INDEX IF NOT EXISTS ns_tasks_target_idx ON ns_tasks (verification_type, verification_target);
      CREATE INDEX IF NOT EXISTS ns_submissions_task_status_idx ON ns_submissions (task_id, status);
      CREATE INDEX IF NOT EXISTS ns_submissions_worker_idx ON ns_submissions (worker_id);
      CREATE INDEX IF NOT EXISTS ns_wallet_user_idx ON ns_wallet_transactions (user_id, type, status);
      CREATE INDEX IF NOT EXISTS ns_verification_task_worker_idx ON ns_verification_events (task_id, worker_id, type, status);
    `);
  }

  private scheduleProjectionSync(): void {
    if (this.projectionSyncRunning) {
      this.projectionSyncPending = true;
      return;
    }

    this.projectionSyncRunning = true;
    void this.runProjectionSyncLoop();
  }

  private async runProjectionSyncLoop(): Promise<void> {
    try {
      do {
        this.projectionSyncPending = false;
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await this.syncProjectionTables(client);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          console.error("Projection table sync failed", error);
        } finally {
          client.release();
        }
      } while (this.projectionSyncPending);
    } finally {
      this.projectionSyncRunning = false;
      if (this.projectionSyncPending) this.scheduleProjectionSync();
    }
  }

  private async syncProjectionTables(client: pg.PoolClient): Promise<void> {
    await client.query("DELETE FROM ns_users");
    await client.query("DELETE FROM ns_tasks");
    await client.query("DELETE FROM ns_submissions");
    await client.query("DELETE FROM ns_wallet_transactions");
    await client.query("DELETE FROM ns_verification_events");
    await client.query("DELETE FROM ns_tracked_chats");

    for (const user of this.state.users) {
      await client.query(
        "INSERT INTO ns_users (id, mode, language, trust_level, is_banned, raw) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
        [user.id, user.mode, user.language, user.trustLevel, user.isBanned, JSON.stringify(user)]
      );
    }

    for (const task of this.state.tasks) {
      await client.query(
        "INSERT INTO ns_tasks (id, buyer_id, category, status, verification_type, verification_target, raw) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        [task.id, task.buyerId, task.category, task.status, task.verificationType ?? null, task.verificationTarget ?? null, JSON.stringify(task)]
      );
    }

    for (const submission of this.state.submissions) {
      await client.query(
        "INSERT INTO ns_submissions (id, task_id, worker_id, status, raw) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [submission.id, submission.taskId, submission.workerId, submission.status, JSON.stringify(submission)]
      );
    }

    for (const transaction of this.state.walletTransactions) {
      await client.query(
        "INSERT INTO ns_wallet_transactions (id, user_id, type, status, amount, raw) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
        [transaction.id, transaction.userId, transaction.type, transaction.status, transaction.amount, JSON.stringify(transaction)]
      );
    }

    for (const event of this.state.verificationEvents) {
      await client.query(
        "INSERT INTO ns_verification_events (id, task_id, worker_id, type, status, raw) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
        [event.id, event.taskId, event.workerId, event.type, event.status, JSON.stringify(event)]
      );
    }

    for (const chat of this.state.trackedChats) {
      await client.query(
        "INSERT INTO ns_tracked_chats (id, type, bot_status, can_verify_members, raw) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [chat.id, chat.type, chat.botStatus, chat.canVerifyMembers, JSON.stringify(chat)]
      );
    }
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
