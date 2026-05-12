export type UserMode = "freelancer" | "buyer";
export type ButtonStyle = "inline" | "reply";

export type PayoutMethodType = "upi" | "trc20" | "binance_uid" | "bkash";

export interface PayoutMethod {
  type: PayoutMethodType;
  account: string;
  updatedAt: string;
}

export type TaskApprovalType = "manual" | "auto";

export type VerificationType =
  | "telegram_join"
  | "website_visit"
  | "website_final_page"
  | "website_webhook"
  | "app_attribution"
  | "in_app_code"
  | "quiz";

export type TaskStatus = "draft" | "active" | "paused" | "completed" | "cancelled";

export type SubmissionStatus = "pending" | "approved" | "rejected" | "auto_approved";

export type TransactionType =
  | "deposit"
  | "deposit_request"
  | "deposit_rejected"
  | "escrow_lock"
  | "escrow_release"
  | "escrow_refund"
  | "clawback_debit"
  | "clawback_refund"
  | "earn"
  | "fee"
  | "withdraw_request"
  | "withdraw_paid"
  | "withdraw_rejected";

export interface UserProfile {
  id: number;
  username?: string;
  firstName?: string;
  language: "en" | "bn";
  mode: UserMode;
  buttonStyle: ButtonStyle;
  payoutMethod?: PayoutMethod;
  isBanned: boolean;
  trustLevel: "new" | "verified" | "trusted" | "pro";
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  buyerId: number;
  title: string;
  category: string;
  instructions: string;
  rewardPerWorker: number;
  workerLimit: number;
  completedCount: number;
  approvalType: TaskApprovalType;
  verificationType?: VerificationType;
  verificationTarget?: string;
  verificationTargetTitle?: string;
  verificationTargetUrl?: string;
  websiteVisitSeconds?: number;
  proofRequired: boolean;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  id: string;
  taskId: string;
  workerId: number;
  proof?: string;
  status: SubmissionStatus;
  rewardAmount: number;
  rejectReason?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface WalletTransaction {
  id: string;
  userId: number;
  type: TransactionType;
  amount: number;
  status: "pending" | "completed" | "rejected";
  taskId?: string;
  submissionId?: string;
  note?: string;
  holdUntil?: string;
  createdAt: string;
}

export interface Withdrawal {
  id: string;
  userId: number;
  amount: number;
  method: string;
  status: "pending" | "paid" | "rejected";
  rejectReason?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface DepositRequest {
  id: string;
  userId: number;
  amount: number;
  method: string;
  requestedCurrency?: "BDT" | "USD";
  requestedAmount?: number;
  proof?: string;
  status: "pending" | "approved" | "rejected";
  rejectReason?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface VerificationEvent {
  id: string;
  taskId: string;
  workerId: number;
  type: VerificationType;
  status: "passed" | "failed";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Referral {
  id: string;
  referrerId: number;
  referredUserId: number;
  bonusAmount: number;
  status: "credited" | "blocked";
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  userId: number;
  message: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
}

export interface Dispute {
  id: string;
  submissionId: string;
  taskId: string;
  workerId: number;
  buyerId: number;
  reason: string;
  status: "open" | "worker_paid" | "rejection_upheld";
  createdAt: string;
  resolvedAt?: string;
}

export interface TrackedChat {
  id: number;
  title?: string;
  type: "group" | "supergroup" | "channel" | "private";
  botStatus: string;
  canVerifyMembers: boolean;
  canInviteUsers?: boolean;
  updatedAt: string;
}

export interface TelegramInviteLinkRecord {
  id: string;
  taskId: string;
  workerId: number;
  chatId: number;
  inviteLink: string;
  chatTitle?: string;
  status: "pending" | "used" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
}

export interface TelegramMembershipRecord {
  id: string;
  taskId: string;
  workerId: number;
  buyerId: number;
  chatId: number;
  inviteLinkId?: string;
  submissionId?: string;
  rewardAmount: number;
  recoveredAmount: number;
  active: boolean;
  joinedAt: string;
  leftAt?: string;
}

export interface AdminPanelMessage {
  id: string;
  entityType: "withdrawal";
  entityId: string;
  chatId: number;
  messageId: number;
  surface: "channel" | "group";
  createdAt: string;
  updatedAt: string;
}

export type AdminRole = "owner" | "manager" | "finance" | "reviewer" | "support";

export interface AdminMember {
  userId: number;
  role: AdminRole;
  active: boolean;
  addedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAuditEvent {
  id: string;
  adminId: number;
  action: string;
  targetType?: string;
  targetId?: string;
  note?: string;
  createdAt: string;
}

export type GeniLinkStatus = "active" | "paused" | "archived";

export interface GeniLink {
  id: string;
  name: string;
  adminId: number;
  status: GeniLinkStatus;
  taskId?: string;
  shortenerUrl?: string;
  rewardPerWorker?: number;
  workerLimit?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GeniVisit {
  id: string;
  linkId: string;
  sessionId: string;
  status: "started" | "completed";
  workerId?: number;
  telegramUserId?: number;
  ip?: string;
  userAgent?: string;
  country?: string;
  deviceType?: string;
  browser?: string;
  referrer?: string;
  suspectReason?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
}

export interface GeniSettings {
  profitCpmUsd: number;
  trafficCostPerVisitUsd: number;
  plannedVisits: number;
  expectedCompletionRate: number;
  sameIpLimit: number;
  sameDeviceLimit: number;
  blockBotUserAgents: boolean;
  flagDirectFinalHits: boolean;
  updatedAt: string;
}

export interface StoreState {
  users: UserProfile[];
  tasks: Task[];
  submissions: Submission[];
  walletTransactions: WalletTransaction[];
  deposits: DepositRequest[];
  withdrawals: Withdrawal[];
  verificationEvents: VerificationEvent[];
  referrals: Referral[];
  supportTickets: SupportTicket[];
  disputes: Dispute[];
  trackedChats: TrackedChat[];
  telegramInviteLinks: TelegramInviteLinkRecord[];
  telegramMemberships: TelegramMembershipRecord[];
  adminPanelMessages: AdminPanelMessage[];
  adminMembers: AdminMember[];
  adminAuditEvents: AdminAuditEvent[];
  geniLinks: GeniLink[];
  geniVisits: GeniVisit[];
  geniSettings: GeniSettings;
}

export interface ApiVerificationPayload {
  taskId: string;
  workerId: number;
  secret?: string;
  proof?: string;
  event?: string;
  code?: string;
}
