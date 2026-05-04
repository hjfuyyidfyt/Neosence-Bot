import { config } from "./config.js";
import type {
  StoreState,
  Submission,
  Task,
  TaskApprovalType,
  UserMode,
  UserProfile,
  VerificationType,
  WalletTransaction,
  Withdrawal
} from "./types.js";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function getOrCreateUser(state: StoreState, from: {
  id: number;
  username?: string;
  first_name?: string;
}): UserProfile {
  const existing = state.users.find((user) => user.id === from.id);
  if (existing) {
    return {
      ...existing,
      username: from.username ?? existing.username,
      firstName: from.first_name ?? existing.firstName,
      updatedAt: now()
    };
  }

  return {
    id: from.id,
    username: from.username,
    firstName: from.first_name,
    mode: "freelancer",
    isBanned: false,
    trustLevel: "new",
    createdAt: now(),
    updatedAt: now()
  };
}

export function switchMode(user: UserProfile, mode: UserMode): UserProfile {
  return { ...user, mode, updatedAt: now() };
}

export function createTask(input: {
  buyerId: number;
  title: string;
  category: string;
  instructions: string;
  rewardPerWorker: number;
  workerLimit: number;
  approvalType: TaskApprovalType;
  verificationType?: VerificationType;
  verificationTarget?: string;
}): Task {
  return {
    id: id("task"),
    buyerId: input.buyerId,
    title: input.title,
    category: input.category,
    instructions: input.instructions,
    rewardPerWorker: input.rewardPerWorker,
    workerLimit: input.workerLimit,
    completedCount: 0,
    approvalType: input.approvalType,
    verificationType: input.verificationType,
    verificationTarget: input.verificationTarget,
    proofRequired: input.approvalType === "manual",
    status: "active",
    createdAt: now(),
    updatedAt: now()
  };
}

export function escrowRequired(task: Task): number {
  const rewardTotal = task.rewardPerWorker * task.workerLimit;
  const fee = rewardTotal * (config.platformFeePercent / 100);
  return roundMoney(rewardTotal + fee);
}

export function createSubmission(task: Task, workerId: number, proof?: string): Submission {
  return {
    id: id("sub"),
    taskId: task.id,
    workerId,
    proof,
    status: task.approvalType === "manual" ? "pending" : "auto_approved",
    rewardAmount: task.rewardPerWorker,
    createdAt: now()
  };
}

export function createTransaction(input: {
  userId: number;
  type: WalletTransaction["type"];
  amount: number;
  status?: WalletTransaction["status"];
  taskId?: string;
  submissionId?: string;
  note?: string;
}): WalletTransaction {
  return {
    id: id("txn"),
    userId: input.userId,
    type: input.type,
    amount: roundMoney(input.amount),
    status: input.status ?? "completed",
    taskId: input.taskId,
    submissionId: input.submissionId,
    note: input.note,
    createdAt: now()
  };
}

export function createWithdrawal(userId: number, amount: number, method: string): Withdrawal {
  return {
    id: id("wd"),
    userId,
    amount: roundMoney(amount),
    method,
    status: "pending",
    createdAt: now()
  };
}

export function walletSummary(state: StoreState, userId: number) {
  const completed = state.walletTransactions.filter((item) => item.userId === userId && item.status === "completed");
  const pending = state.walletTransactions.filter((item) => item.userId === userId && item.status === "pending");

  const available = completed.reduce((sum, item) => {
    if (["deposit", "earn", "escrow_refund", "withdraw_rejected"].includes(item.type)) return sum + item.amount;
    if (["escrow_lock", "withdraw_request"].includes(item.type)) return sum - item.amount;
    return sum;
  }, 0);

  const pendingAmount = pending.reduce((sum, item) => sum + item.amount, 0);
  const escrow = completed
    .filter((item) => item.type === "escrow_lock" || item.type === "escrow_release" || item.type === "escrow_refund")
    .reduce((sum, item) => {
      if (item.type === "escrow_lock") return sum + item.amount;
      return sum - item.amount;
    }, 0);

  return {
    available: roundMoney(available),
    pending: roundMoney(pendingAmount),
    withdrawable: roundMoney(Math.max(available, 0)),
    escrow: roundMoney(Math.max(escrow, 0))
  };
}

export function visibleTasks(state: StoreState, workerId: number): Task[] {
  const attempted = new Set(state.submissions.filter((item) => item.workerId === workerId).map((item) => item.taskId));
  return state.tasks.filter(
    (task) =>
      task.status === "active" &&
      task.buyerId !== workerId &&
      task.completedCount < task.workerLimit &&
      !attempted.has(task.id)
  );
}

export function approveSubmission(state: StoreState, submissionId: string): {
  submission: Submission;
  task: Task;
  earnTransaction: WalletTransaction;
  escrowReleaseTransaction: WalletTransaction;
} {
  const submission = state.submissions.find((item) => item.id === submissionId);
  if (!submission) throw new Error("Submission not found");
  if (submission.status !== "pending") throw new Error("Submission is not pending");
  const task = state.tasks.find((item) => item.id === submission.taskId);
  if (!task) throw new Error("Task not found");

  const approvedSubmission: Submission = {
    ...submission,
    status: "approved",
    reviewedAt: now()
  };
  const updatedTask: Task = {
    ...task,
    completedCount: task.completedCount + 1,
    status: task.completedCount + 1 >= task.workerLimit ? "completed" : task.status,
    updatedAt: now()
  };

  return {
    submission: approvedSubmission,
    task: updatedTask,
    earnTransaction: createTransaction({
      userId: submission.workerId,
      type: "earn",
      amount: submission.rewardAmount,
      taskId: task.id,
      submissionId: submission.id
    }),
    escrowReleaseTransaction: createTransaction({
      userId: task.buyerId,
      type: "escrow_release",
      amount: submission.rewardAmount,
      taskId: task.id,
      submissionId: submission.id
    })
  };
}

export function rejectSubmission(state: StoreState, submissionId: string, reason: string): Submission {
  const submission = state.submissions.find((item) => item.id === submissionId);
  if (!submission) throw new Error("Submission not found");
  if (submission.status !== "pending") throw new Error("Submission is not pending");
  return {
    ...submission,
    status: "rejected",
    rejectReason: reason,
    reviewedAt: now()
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
