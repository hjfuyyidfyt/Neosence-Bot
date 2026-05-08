export type UserMode = "freelancer" | "buyer";

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
  createdAt: string;
}

export interface Withdrawal {
  id: string;
  userId: number;
  amount: number;
  method: string;
  status: "pending" | "paid" | "rejected";
  createdAt: string;
  reviewedAt?: string;
}

export interface DepositRequest {
  id: string;
  userId: number;
  amount: number;
  method: string;
  proof?: string;
  status: "pending" | "approved" | "rejected";
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
}

export interface ApiVerificationPayload {
  taskId: string;
  workerId: number;
  secret?: string;
  proof?: string;
  event?: string;
  code?: string;
}
