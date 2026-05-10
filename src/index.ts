import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Context, Markup, Telegraf } from "telegraf";
import { config, isAdmin } from "./config.js";
import { runtime } from "./runtime.js";
import { createStore } from "./store.js";
import {
  approveSubmission,
  createDepositRequest,
  createDispute,
  createSubmission,
  createReferral,
  createTask,
  createTransaction,
  createSupportTicket,
  createVerificationEvent,
  createWithdrawal,
  escrowRequired,
  calculateTrustLevel,
  calculateTrustScore,
  getOrCreateUser,
  rejectSubmission,
  switchMode,
  visibleTasks,
  walletSummary
} from "./services.js";
import { formatTask, mainMenu, modeMenu, taskActionButtons, taskHtmlExtra } from "./ui.js";
import { getMessages, t } from "./messages.js";
import { formatMoney, formatMoneyDetail, roundMoney } from "./money.js";
import type { MessageBundle } from "./messages.js";
import type {
  AdminAuditEvent,
  AdminMember,
  AdminPanelMessage,
  AdminRole,
  ApiVerificationPayload,
  DepositRequest,
  Dispute,
  GeniLink,
  GeniSettings,
  GeniVisit,
  PayoutMethodType,
  Submission,
  Task,
  TaskApprovalType,
  TaskStatus,
  TelegramInviteLinkRecord,
  TelegramMembershipRecord,
  TrackedChat,
  UserProfile,
  VerificationType,
  Withdrawal
} from "./types.js";

const store = createStore({ databaseUrl: config.databaseUrl, dataFile: config.dataFile });
const telegramWebhookPath = "/telegram/webhook";
let telegramWebhookCallback: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;

createServer((request, response) => {
  void handleHttpRequest(request, response);
}).listen(config.port, () => {
  console.log(`Health server listening on ${config.port}`);
});

await store.load();

const bot = new Telegraf(config.botToken);
const proofWaiters = new Map<number, string>();
const quizWaiters = new Map<number, string>();
const codeWaiters = new Map<number, string>();
const supportWaiters = new Set<number>();
const earnSkips = new Map<string, Set<string>>();
type WithdrawIntent = "all" | "custom" | "change";
const payoutSetupWaiters = new Map<number, { method: PayoutMethodType; intent: WithdrawIntent; amount?: number }>();
const customWithdrawWaiters = new Set<number>();
const activeScreenMessages = new Map<number, { chatId: number | string; messageId: number }>();
type TaskDraftStep =
  | "task_type"
  | "title"
  | "category"
  | "approval"
  | "reward"
  | "workers"
  | "instructions"
  | "verification"
  | "target"
  | "website_timer"
  | "confirm";

interface TaskDraft {
  step: TaskDraftStep;
  title?: string;
  category?: string;
  approvalType?: TaskApprovalType;
  rewardPerWorker?: number;
  workerLimit?: number;
  instructions?: string;
  verificationType?: VerificationType;
  verificationTarget?: string;
  websiteVisitSeconds?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const taskDrafts = new Map<number, TaskDraft>();
type GeniDraftStep = "name" | "shortener" | "profit_cpm" | "profit_cost" | "profit_visits" | "profit_rate";

interface GeniDraft {
  step: GeniDraftStep;
  linkId?: string;
  name?: string;
  profitCpmUsd?: number;
  trafficCostPerVisitUsd?: number;
  plannedVisits?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const geniDrafts = new Map<number, GeniDraft>();
const DRAFT_TTL_MS = 60 * 60 * 1000;
const VERIFY_COOLDOWN_MS = 15 * 1000;
const TELEGRAM_INVITE_LINK_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query", "channel_post", "my_chat_member", "chat_member"] as const;
const verifyCooldowns = new Map<string, number>();
const ACTIVE_TASK_CATEGORIES = new Set(["telegram", "website"]);
const MIN_REWARD_USD: Record<string, number> = {
  telegram: 0.01,
  website: 0.034
};
const localId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const compactId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const PUBLIC_BOT_COMMANDS = [
  { command: "start", description: "🏠 Open Neosence home" },
  { command: "earn", description: "💼 Find tasks to complete" },
  { command: "wallet", description: "💰 View wallet and withdrawals" },
  { command: "profile", description: "👤 View profile and trust score" },
  { command: "language", description: "🌐 Change language" },
  { command: "cancel", description: "✖️ Cancel current flow" }
];
const ADMIN_CONSOLE_COMMANDS = [
  { command: "admin", description: "🛠️ Open admin dashboard" },
  { command: "chatid", description: "🆔 Show this group or channel ID" },
  { command: "help", description: "❔ Show admin command guide" },
  { command: "stats", description: "📊 View live platform stats" },
  { command: "pending", description: "⏳ Review all pending items" },
  { command: "refresh", description: "🔄 Sync admin panel messages" },
  { command: "withdrawals", description: "🏦 Show pending withdrawals" },
  { command: "paywd", description: "✅ Mark withdrawal as paid" },
  { command: "rejectwd", description: "❌ Reject withdrawal with reason" },
  { command: "paywithdraw", description: "✅ Legacy withdrawal paid command" },
  { command: "rejectwithdraw", description: "❌ Legacy withdrawal reject command" },
  { command: "deposits", description: "🧾 Show pending deposits" },
  { command: "approvedeposit", description: "💰 Approve and credit deposit" },
  { command: "rejectdeposit", description: "🚫 Reject deposit with reason" },
  { command: "deposit", description: "➕ Add balance to a user" },
  { command: "submissions", description: "📌 Show pending manual proofs" },
  { command: "approve", description: "✅ Approve manual proof" },
  { command: "reject", description: "❌ Reject manual proof with reason" },
  { command: "disputes", description: "⚖️ Show open disputes" },
  { command: "resolvedispute", description: "🧑‍⚖️ Resolve dispute decision" },
  { command: "tickets", description: "🎧 Show open support tickets" },
  { command: "closeticket", description: "✅ Close a support ticket" },
  { command: "user", description: "👤 View user wallet and activity" },
  { command: "admins", description: "👮 Manage admin team and roles" },
  { command: "addadmin", description: "➕ Add admin with role" },
  { command: "removeadmin", description: "🗑️ Remove admin access" },
  { command: "role", description: "🔐 Change admin role" },
  { command: "ban", description: "🔒 Ban a user from Neosence" },
  { command: "unban", description: "🔓 Restore user access" },
  { command: "broadcast", description: "📣 Prepare announcement flow" },
  { command: "audit", description: "🧾 View recent admin activity" },
  { command: "settings", description: "⚙️ View system settings" },
  { command: "geni", description: "🧪 Open GENI short-link lab" }
];
const ADMIN_PANEL_CHANNEL_COMMANDS = [
  { command: "chatid", description: "🆔 Show this channel ID" },
  { command: "refresh", description: "🔄 Refresh pending panel cards" }
];
const botRuntime = {
  launchState: "starting" as "starting" | "running" | "stopped" | "failed",
  lastError: undefined as string | undefined
};

type ReplyMarkup = Parameters<Context["reply"]>[1];

bot.use(async (ctx, next) => {
  if (!ctx.from || isAdminUser(ctx.from.id)) {
    await next();
    return;
  }

  const user = store.snapshot().users.find((item) => item.id === ctx.from?.id);
  if (user?.isBanned) {
    await ctx.reply(getMessages(user.language).common.banned);
    return;
  }

  await next();
});

bot.start(async (ctx) => {
  const payload = getStartPayload(ctx.message.text);
  const wasExistingUser = store.snapshot().users.some((item) => item.id === ctx.from.id);
  const user = await ensureUser(ctx.from);
  if (payload?.startsWith("geni_")) {
    await handleGeniTelegramVerify(ctx, payload);
    return;
  }

  const referralMessage = await maybeApplyReferral(payload, user.id, wasExistingUser);
  const messages = getMessages(user.language);
  await ctx.reply(
    [
      messages.start.welcome,
      "",
      `${messages.start.currentWorkspace} ${formatMode(user.mode, user.language)}.`,
      referralMessage
    ].filter(Boolean).join("\n"),
    mainMenu(user)
  );
});

bot.command("mode", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  await ctx.reply(messages.start.chooseMode, modeMenu(user.language));
});

bot.command("language", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatLanguageStatus(user.language), languageKeyboard(user.language));
});

bot.command("earn", async (ctx) => {
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.command("wallet", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatWallet(user.id, user.mode, user.language));
});

bot.command("profile", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatUserProfile(user.id, user.language), mainMenu(user));
});

bot.command("cancel", async (ctx) => {
  await ensureUser(ctx.from);
  taskDrafts.delete(ctx.from.id);
  proofWaiters.delete(ctx.from.id);
  quizWaiters.delete(ctx.from.id);
  codeWaiters.delete(ctx.from.id);
  payoutSetupWaiters.delete(ctx.from.id);
  customWithdrawWaiters.delete(ctx.from.id);
  supportWaiters.delete(ctx.from.id);
  geniDrafts.delete(ctx.from.id);
  await ctx.reply(userMessages(ctx.from.id).common.currentInputCancelled);
});

bot.command("chatid", async (ctx) => {
  if (!ctx.from || !isAdminUser(ctx.from.id)) return;
  if (ctx.chat.type === "private") {
    await ctx.reply(adminUnknownCommandText());
    return;
  }
  await ctx.reply(`Chat ID: ${ctx.chat.id}`);
});

bot.command("posttask", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  if (user.mode !== "buyer") {
    await ctx.reply(messages.common.switchToBuyer, mainMenu(user));
    return;
  }

  const text = ctx.message.text.replace("/posttask", "").trim();

  if (!text) {
    await startTaskWizard(ctx);
    return;
  }

  const parts = text.split("|").map((item) => item.trim());
  if (parts.length < 6) {
    await ctx.reply(messages.taskWizard.commandFields);
    return;
  }

  const [title, category, approvalRaw, rewardRaw, workersRaw, instructions, verificationRaw, target] = parts;
  const approvalType = approvalRaw as TaskApprovalType;
  const rewardPerWorker = parseRewardInput(rewardRaw, user.language);
  const workerLimit = Number(workersRaw);

  if (!["manual", "auto"].includes(approvalType) || !Number.isFinite(rewardPerWorker) || !Number.isInteger(workerLimit)) {
    await ctx.reply(messages.taskWizard.invalidCommandFields);
    return;
  }
  try {
    assertActiveTaskCategory(category, user.language);
    assertMinimumReward(category, rewardPerWorker, user.language);
  } catch (error) {
    await ctx.reply((error as Error).message);
    return;
  }

  const task = withTaskTargetMetadata(createTask({
    buyerId: user.id,
    title,
    category,
    instructions,
    rewardPerWorker,
    workerLimit,
    approvalType,
    verificationType: verificationRaw as VerificationType | undefined,
    verificationTarget: target,
    websiteVisitSeconds: verificationRaw === "website_visit" ? 30 : undefined
  }));
  try {
    assertCampaignTargetAllowed(task);
    assertEnoughWithdrawableForEscrow(user.id, escrowRequired(task), user.language);
  } catch (error) {
    await ctx.reply((error as Error).message);
    return;
  }

  await store.addTask(task);
  await store.addTransaction(createTransaction({
    userId: user.id,
    type: "escrow_lock",
    amount: escrowRequired(task),
    taskId: task.id,
    note: "MVP records escrow lock. Connect deposit validation before public launch."
  }));

  await ctx.reply(`${messages.taskWizard.published}\n\n${formatTask(task, user.language)}\n\n${messages.wallet.escrowLocked} ${formatMoneyDetail(escrowRequired(task), user.language)}`, taskHtmlExtra());
});

bot.command("mytasks", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const state = store.snapshot();
  const owned = state.tasks.filter((task) => task.buyerId === user.id);
  const submissions = state.submissions.filter((submission) => submission.workerId === user.id);

  await ctx.reply([
    `Owned tasks: ${owned.length}`,
    ...owned.slice(0, 8).map((task) => `- ${task.id}: ${task.title} (${task.status}, ${task.completedCount}/${task.workerLimit})`),
    "",
    `Your submissions: ${submissions.length}`,
    ...submissions.slice(0, 8).map((submission) => `- ${submission.id}: ${submission.status}, ${submission.rewardAmount} BDT`)
  ].join("\n"));
});

bot.command("withdraw", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const [, amountRaw, ...methodParts] = ctx.message.text.split(" ");
  const amount = Number(amountRaw);
  const method = methodParts.join(" ");

  if (!Number.isFinite(amount) || amount <= 0 || !method) {
    await ctx.reply("Format: /withdraw 100 bkash:01XXXXXXXXX");
    return;
  }

  const wallet = walletSummary(store.snapshot(), user.id);
  if (wallet.withdrawable < amount) {
    await ctx.reply(`Insufficient withdrawable balance. Current withdrawable: ${wallet.withdrawable} BDT`);
    return;
  }

  const withdrawal = createWithdrawal(user.id, amount, method);
  await store.addWithdrawal(withdrawal);
  await store.addTransaction(createTransaction({
    userId: user.id,
    type: "withdraw_request",
    amount,
    note: method
  }));
  await publishWithdrawalPanel(withdrawal);
  await ctx.reply(`✅ Withdrawal request submitted\n\nID: ${withdrawal.id}`);
});

bot.command("dispute", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const [, submissionId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim();
  if (!submissionId || !reason) {
    await ctx.reply("Format: /dispute <submissionId> <reason>");
    return;
  }

  try {
    const dispute = await openDispute(submissionId, user.id, reason);
    await ctx.reply(`Dispute opened: ${dispute.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("depositreq", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const [, amountRaw, methodRaw, ...proofParts] = ctx.message.text.split(" ");
  const amount = Number(amountRaw);
  const method = methodRaw?.trim();
  const proof = proofParts.join(" ").trim();

  if (!Number.isFinite(amount) || amount <= 0 || !method || !proof) {
    await ctx.reply("Format: /depositreq 500 bkash trxid-or-proof-note");
    return;
  }

  const deposit = createDepositRequest({
    userId: user.id,
    amount,
    method,
    proof
  });
  await store.addDeposit(deposit);
  await store.addTransaction(createTransaction({
    userId: user.id,
    type: "deposit_request",
    amount,
    note: `${method}: ${proof}`
  }));
  await ctx.reply(`✅ Deposit request submitted\n\nID: ${deposit.id}\nAmount: ${deposit.amount} BDT\nStatus: ${deposit.status}`);
});

bot.command("admin", async (ctx) => {
  if (!(await requireAdminConsole(ctx))) return;
  await ctx.reply(formatAdminDashboard(), adminDashboardKeyboard());
});

bot.command("help", async (ctx) => {
  if (!(await requireAdminConsole(ctx))) return;
  await ctx.reply(formatAdminHelp(), adminHelpKeyboard());
});

bot.command("stats", async (ctx) => {
  if (!(await requireAdminConsole(ctx))) return;
  await ctx.reply(formatAdminStats(), adminStatsKeyboard());
});

bot.command("pending", async (ctx) => {
  if (!(await requireAdminConsole(ctx))) return;
  await ctx.reply(formatAdminPending(), adminPendingKeyboard());
});

bot.command("refresh", async (ctx) => {
  if (!(await requireAdminConsole(ctx))) return;
  const count = await refreshAdminPanelMessages();
  await ctx.reply(`🔄 Panel synced\n\nPending withdrawals refreshed: ${count}`, adminBackKeyboard());
});

bot.command("withdrawals", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  await ctx.reply(formatAdminWithdrawalList(), adminWithdrawalListKeyboard());
});

bot.command("deposits", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  await ctx.reply(formatAdminDepositList(), adminDepositListKeyboard());
});

bot.command("submissions", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "review"))) return;
  const pendingSubmissions = store.snapshot().submissions.filter((item) => item.status === "pending");
  await ctx.reply(formatPendingSubmissions(pendingSubmissions), adminSubmissionListKeyboard(pendingSubmissions));
});

bot.command("settings", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "settings"))) return;
  await ctx.reply(formatAdminSettings(), adminSettingsKeyboard());
});

bot.command("geni", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "geni"))) return;
  await showScreen(ctx, formatGeniSimpleHome(), geniSimpleKeyboard());
});

bot.command("audit", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "settings"))) return;
  await ctx.reply(formatAdminAudit(), adminAuditKeyboard());
});

bot.command("broadcast", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "settings"))) return;
  await ctx.reply([
    "📣 Broadcast",
    "",
    "Broadcast drafting is reserved for the next admin-panel slice.",
    "For now, keep announcements manual so no message is sent accidentally."
  ].join("\n"), adminBackKeyboard());
});

bot.command("disputes", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "review"))) return;
  await ctx.reply(formatOpenDisputes(), disputeListKeyboard(store.snapshot().disputes.filter((item) => item.status === "open")));
});

bot.command("resolvedispute", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "review"))) return;
  const [, disputeId, resolution] = ctx.message.text.split(" ");
  if (!disputeId || !["pay", "uphold"].includes(resolution)) {
    await ctx.reply("Format: /resolvedispute <disputeId> pay/uphold");
    return;
  }

  try {
    const dispute = resolution === "pay"
      ? await resolveDisputePayWorker(disputeId)
      : await resolveDisputeUphold(disputeId);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "resolve_dispute",
      targetType: "dispute",
      targetId: dispute.id,
      note: dispute.status
    });
    await ctx.reply(`Dispute resolved: ${dispute.id} (${dispute.status})`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("tickets", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "support"))) return;
  await ctx.reply(formatOpenTickets(), adminTicketsKeyboard());
});

bot.command("closeticket", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "support"))) return;
  const [, ticketId] = ctx.message.text.split(" ");
  if (!ticketId) {
    await ctx.reply("Format: /closeticket <ticketId>");
    return;
  }

  try {
    const ticket = await closeSupportTicket(ticketId);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "close_ticket",
      targetType: "ticket",
      targetId: ticket.id
    });
    await ctx.reply(`Closed ticket ${ticket.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("ban", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "moderation"))) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId)) {
    await ctx.reply("Format: /ban <userId>");
    return;
  }

  try {
    const user = await setUserBanStatus(userId, true);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "ban_user",
      targetType: "user",
      targetId: String(user.id)
    });
    await ctx.reply(`Banned user ${user.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("unban", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "moderation"))) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId)) {
    await ctx.reply("Format: /unban <userId>");
    return;
  }

  try {
    const user = await setUserBanStatus(userId, false);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "unban_user",
      targetType: "user",
      targetId: String(user.id)
    });
    await ctx.reply(`Unbanned user ${user.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("user", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "users"))) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId)) {
    await ctx.reply("Format: /user <userId>");
    return;
  }

  await ctx.reply(formatUserLookup(userId));
});

bot.command("admins", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "admin_management"))) return;
  await ctx.reply(formatAdminManagement(), adminManagementKeyboard());
});

bot.command("addadmin", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "admin_management"))) return;
  const [, userIdRaw, roleRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  const role = parseAdminRole(roleRaw);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !role) {
    await ctx.reply("Format: /addadmin <userId> owner|manager|finance|reviewer|support");
    return;
  }

  try {
    const member = await setAdminMember(userId, role, ctx.from.id, true);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "add_admin",
      targetType: "admin",
      targetId: String(member.userId),
      note: adminRoleLabel(member.role)
    });
    await ctx.reply(`Admin added: ${member.userId} (${adminRoleLabel(member.role)})`, adminManagementKeyboard());
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("removeadmin", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "admin_management"))) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    await ctx.reply("Format: /removeadmin <userId>");
    return;
  }

  try {
    const member = await removeAdminMember(userId);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "remove_admin",
      targetType: "admin",
      targetId: String(member.userId),
      note: adminRoleLabel(member.role)
    });
    await ctx.reply(`Admin removed: ${member.userId}`, adminManagementKeyboard());
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("role", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "admin_management"))) return;
  const [, userIdRaw, roleRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  const role = parseAdminRole(roleRaw);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !role) {
    await ctx.reply("Format: /role <userId> owner|manager|finance|reviewer|support");
    return;
  }

  try {
    const member = await setAdminMember(userId, role, ctx.from.id, true);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "change_admin_role",
      targetType: "admin",
      targetId: String(member.userId),
      note: adminRoleLabel(member.role)
    });
    await ctx.reply(`Admin role updated: ${member.userId} (${adminRoleLabel(member.role)})`, adminManagementKeyboard());
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("deposit", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, userIdRaw, amountRaw, ...noteParts] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  const amount = Number(amountRaw);
  const note = noteParts.join(" ").trim() || "Admin deposit";

  if (!Number.isFinite(userId) || !Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Format: /deposit <userId> <amount> <note>");
    return;
  }

  await store.addTransaction(createTransaction({
    userId,
    type: "deposit",
    amount,
    note
  }));
  await addAdminAudit({
    adminId: ctx.from.id,
    action: "manual_deposit",
    targetType: "user",
    targetId: String(userId),
    note: `${amount} BDT`
  });
  await ctx.reply(`Deposited ${amount} BDT to user ${userId}.`);
});

bot.command("approvedeposit", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, depositId] = ctx.message.text.split(" ");
  if (!depositId) {
    await ctx.reply("Format: /approvedeposit <depositId>");
    return;
  }

  try {
    const deposit = await approveDepositById(depositId);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "approve_deposit",
      targetType: "deposit",
      targetId: deposit.id,
      note: `${deposit.amount} BDT`
    });
    await ctx.reply(`Deposit approved: ${deposit.id}\nUser ${deposit.userId} received ${deposit.amount} BDT.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("rejectdeposit", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, depositId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim() || "Rejected by admin";
  if (!depositId) {
    await ctx.reply("Format: /rejectdeposit <depositId> <reason>");
    return;
  }

  try {
    const deposit = await rejectDepositById(depositId, reason);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "reject_deposit",
      targetType: "deposit",
      targetId: deposit.id,
      note: reason
    });
    await ctx.reply(`Deposit rejected: ${deposit.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("approve", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "review"))) return;
  const [, submissionId] = ctx.message.text.split(" ");
  if (!submissionId) {
    await ctx.reply("Format: /approve <submissionId>");
    return;
  }

  try {
    const result = await approveSubmissionById(submissionId, ctx.from.id);
    await ctx.reply(`Approved ${submissionId}. Worker earned ${result.rewardAmount} BDT.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("reject", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "review"))) return;
  const [, submissionId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim();
  if (!submissionId || !reason) {
    await ctx.reply("Format: /reject <submissionId> <reason>");
    return;
  }

  try {
    await rejectSubmissionById(submissionId, reason, ctx.from.id);
    await ctx.reply(`Rejected ${submissionId}: ${reason}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("paywithdraw", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, withdrawalId] = ctx.message.text.split(" ");
  if (!withdrawalId) {
    await ctx.reply("Format: /paywithdraw <withdrawalId>");
    return;
  }

  try {
    const withdrawal = await payWithdrawalById(withdrawalId);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "pay_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: `${withdrawal.amount} BDT`
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "paid");
    await acknowledgeAdminCommand(ctx, `Withdrawal paid: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("rejectwithdraw", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, withdrawalId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim();
  if (!withdrawalId || !reason) {
    await ctx.reply("Format: /rejectwithdraw <withdrawalId> <reason>");
    return;
  }

  try {
    const withdrawal = await rejectWithdrawalById(withdrawalId, reason);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "reject_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: reason
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "rejected");
    await acknowledgeAdminCommand(ctx, `Withdrawal rejected: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("paywd", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, withdrawalId] = ctx.message.text.split(" ");
  if (!withdrawalId) {
    await ctx.reply("Format: /paywd <withdrawalId>");
    return;
  }

  try {
    const withdrawal = await payWithdrawalById(withdrawalId);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "pay_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: `${withdrawal.amount} BDT`
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "paid");
    await acknowledgeAdminCommand(ctx, `Withdrawal paid: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("rejectwd", async (ctx) => {
  if (!(await requireAdminConsole(ctx, "finance"))) return;
  const [, withdrawalId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim();
  if (!withdrawalId || !reason) {
    await ctx.reply("Format: /rejectwd <withdrawalId> <reason>");
    return;
  }

  try {
    const withdrawal = await rejectWithdrawalById(withdrawalId, reason);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "reject_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: reason
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "rejected");
    await acknowledgeAdminCommand(ctx, `Withdrawal rejected: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action("menu:earn", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.action(/^earn:category:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  await showEarnCategory(ctx, ctx.match[1]);
});

bot.action(/^earn:skip:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Skipped");
  await ensureUser(ctx.from);
  addEarnSkip(ctx.from.id, ctx.match[1], ctx.match[2]);
  await showEarnCategory(ctx, ctx.match[1]);
});

bot.action(/^earn:reset:([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery("Showing skipped tasks again");
  await ensureUser(ctx.from);
  earnSkips.delete(earnSkipKey(ctx.from.id, ctx.match[1]));
  await showEarnCategory(ctx, ctx.match[1]);
});

bot.action("earn:categories", async (ctx) => {
  await ctx.answerCbQuery();
  clearEarnSkips(ctx.from.id);
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.action("menu:post", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  if (user.mode !== "buyer") {
    await ctx.reply(messages.common.switchToBuyer, mainMenu(user));
    return;
  }
  await startTaskWizard(ctx);
});

bot.action("menu:wallet", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, formatWallet(user.id, user.mode, user.language), walletKeyboard(user));
});

bot.action("wallet:deposit_help", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, walletLabels(user.language).depositHelp, walletKeyboard(user));
});

bot.action("menu:mode", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  await showScreen(ctx, messages.start.chooseMode, modeMenu(user.language));
});

bot.action(/^language:(en|bn)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const language = ctx.match[1] as "en" | "bn";
  const updatedUser = {
    ...user,
    language,
    updatedAt: new Date().toISOString()
  };
  await store.upsertUser(updatedUser);
  const userMessages = getMessages(language).language;
  await showScreen(
    ctx,
    language === "en"
      ? userMessages.englishSet
      : userMessages.banglaSet,
    mainMenu(updatedUser)
  );
});

bot.action("menu:jobs", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, userMessages(ctx.from.id).earn.myJobsHelp, homeKeyboard(user));
});

bot.action("menu:campaigns", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  const tasks = store.snapshot().tasks.filter((task) => task.buyerId === user.id && ["active", "paused"].includes(task.status));
  if (tasks.length === 0) {
    await showScreen(ctx, messages.campaigns.none, campaignEmptyKeyboard(user));
    return;
  }

  await showScreen(ctx, formatCampaignList(tasks, user.language), campaignListKeyboard(tasks, user.language));
});

bot.action("menu:campaign_history", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const tasks = store.snapshot().tasks.filter((task) => task.buyerId === user.id && ["completed", "cancelled"].includes(task.status));
  if (tasks.length === 0) {
    await showScreen(ctx, "No completed or cancelled campaigns yet.", Markup.inlineKeyboard([
      [Markup.button.callback("Back to Campaigns", "menu:campaigns")],
      [Markup.button.callback("Home", "menu:home")]
    ]));
    return;
  }

  await showScreen(ctx, formatCampaignHistory(tasks, user.language), campaignHistoryKeyboard(user.language));
});

bot.action("menu:submissions", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  const state = store.snapshot();
  const taskIds = new Set(state.tasks.filter((task) => task.buyerId === user.id).map((task) => task.id));
  const submissions = state.submissions.filter((submission) => taskIds.has(submission.taskId));

  if (submissions.length === 0) {
    await showScreen(ctx, messages.campaigns.noSubmissions, homeKeyboard(user));
    return;
  }

  const pending = submissions.filter((submission) => submission.status === "pending");
  await showScreen(ctx, [
    messages.campaigns.recentSubmissions,
    ...submissions.slice(0, 10).map((submission) => `- ${submission.id}: ${submission.status}, worker ${submission.workerId}, ${submission.rewardAmount} BDT`)
  ].join("\n"), buyerSubmissionKeyboard(pending));
});

bot.action("menu:withdraw", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, formatWallet(user.id, user.mode, user.language), walletKeyboard(user));
});

bot.action("withdraw:all", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const wallet = walletSummary(store.snapshot(), user.id);
  if (wallet.withdrawable <= 0) {
    await showScreen(ctx, walletLabels(user.language).noWithdrawableBalance, walletKeyboard(user));
    return;
  }
  await beginWithdraw(ctx, user, wallet.withdrawable, "all");
});

bot.action("withdraw:custom", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  if (!user.payoutMethod) {
    await showScreen(ctx, "Save a payout method first. Choose one:", payoutMethodKeyboard("custom", user.language));
    return;
  }
  customWithdrawWaiters.add(user.id);
  await showScreen(ctx, formatCustomWithdrawPrompt(user.id, user.language), cancelWithdrawKeyboard(user.language));
});

bot.action("withdraw:change_payout", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, "Choose payout method:", payoutMethodKeyboard("change", user.language));
});

bot.action("withdraw:history", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, formatWithdrawalHistory(user.id, user.language), walletKeyboard(user));
});

bot.action(/^withdraw:method:(upi|trc20|binance_uid|bkash):(all|custom|change)(?::(.+))?$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const method = ctx.match[1] as PayoutMethodType;
  const intent = ctx.match[2] as WithdrawIntent;
  const amount = ctx.match[3] ? Number(ctx.match[3]) : undefined;
  payoutSetupWaiters.set(user.id, { method, intent, amount });
  await showScreen(ctx, payoutAccountPrompt(method, user.language), cancelWithdrawKeyboard(user.language));
});

bot.action(/^withdraw:confirm:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const amount = Number(ctx.match[1]);
  await submitSavedWithdrawal(ctx, user.id, amount);
});

bot.action("withdraw:cancel", async (ctx) => {
  await ctx.answerCbQuery("Cancelled");
  const user = await ensureUser(ctx.from);
  payoutSetupWaiters.delete(user.id);
  customWithdrawWaiters.delete(user.id);
  await showScreen(ctx, formatWallet(user.id, user.mode, user.language), walletKeyboard(user));
});

bot.action("menu:referrals", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, formatReferralStats(user.id, ctx.botInfo?.username, user.language), homeKeyboard(user));
});

bot.action("menu:profile", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, formatUserProfile(user.id, user.language), mainMenu(user));
});

bot.action("menu:language", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, formatLanguageStatus(user.language), languageKeyboard(user.language));
});

bot.action("menu:support", async (ctx) => {
  await ctx.answerCbQuery();
  supportWaiters.add(ctx.from.id);
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, userMessages(ctx.from.id).support.prompt, homeKeyboard(user));
});

bot.action("menu:home", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, homeText(user), mainMenu(user));
});

bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("admin:dashboard", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminDashboard(), adminDashboardKeyboard());
});

bot.action("admin:pending", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminPending(), adminPendingKeyboard());
});

bot.action("admin:stats", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminStats(), adminStatsKeyboard());
});

bot.action("admin:withdrawals", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminWithdrawalList(), adminWithdrawalListKeyboard());
});

bot.action(/^admin:withdraw:view:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;
  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === ctx.match[1]);
  if (!withdrawal) {
    await ctx.answerCbQuery("Withdrawal not found.", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await showScreen(ctx, formatWithdrawalPanelCard(withdrawal, "group"), adminWithdrawalKeyboard(withdrawal));
});

bot.action("admin:deposits", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminDepositList(), adminDepositListKeyboard());
});

bot.action("admin:submissions", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "review"))) return;
  await ctx.answerCbQuery();
  const pendingSubmissions = store.snapshot().submissions.filter((item) => item.status === "pending");
  await showScreen(ctx, formatPendingSubmissions(pendingSubmissions), adminSubmissionListKeyboard(pendingSubmissions));
});

bot.action("admin:disputes", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "review"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatOpenDisputes(), disputeListKeyboard(store.snapshot().disputes.filter((item) => item.status === "open")));
});

bot.action("admin:tickets", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "support"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatOpenTickets(), adminTicketsKeyboard());
});

bot.action("admin:users", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "users"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, [
    "👤 User Lookup",
    "",
    "Use:",
    "<code>/user 7020461098</code>",
    "<code>/ban 7020461098 reason</code>",
    "<code>/unban 7020461098</code>"
  ].join("\n"), taskHtmlExtra(adminUsersKeyboard()));
});

bot.action("admin:settings", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "settings"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminSettings(), adminSettingsKeyboard());
});

bot.action("admin:help", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminHelp(), adminHelpKeyboard());
});

bot.action("admin:refresh", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx))) return;
  const count = await refreshAdminPanelMessages();
  await ctx.answerCbQuery("Panel synced.");
  await showScreen(ctx, `🔄 Panel synced\n\nPending withdrawals refreshed: ${count}`, adminBackKeyboard());
});

bot.action("admin:admins", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "admin_management"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminManagement(), adminManagementKeyboard());
});

bot.action("admin:admins:list", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "admin_management"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminList(), adminManagementKeyboard());
});

bot.action("admin:admins:roles", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "admin_management"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminRoles(), adminManagementKeyboard());
});

bot.action("admin:admins:add_help", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "admin_management"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, [
    "➕ Add Admin",
    "",
    "Use one command in this console group:",
    "/addadmin <userId> owner|manager|finance|reviewer|support",
    "",
    "Examples:",
    "/addadmin 123456 finance",
    "/role 123456 reviewer",
    "/removeadmin 123456"
  ].join("\n"), adminManagementKeyboard());
});

bot.action("admin:audit", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "settings"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatAdminAudit(), adminAuditKeyboard());
});

bot.action("geni:dashboard", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniSimpleHome(), geniSimpleKeyboard());
});

bot.action("geni:advanced", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniAdvancedDashboard(), geniAdvancedKeyboard());
});

bot.action("geni:new", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  setGeniDraft(ctx.from.id, { step: "name" });
  await showScreen(ctx, [
    "➕ Create Tracking Link",
    "",
    "Send a simple name.",
    "",
    "Example:",
    "My Shortener Test"
  ].join("\n"), geniCancelKeyboard());
});

bot.action("geni:links", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniLinks(), geniLinksKeyboard());
});

bot.action("geni:analytics", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniAnalytics(), geniAdvancedKeyboard());
});

bot.action("geni:logs", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniLogs(), geniAdvancedKeyboard());
});

bot.action("geni:results", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniSimpleResults(), geniResultsKeyboard());
});

bot.action("geni:stop", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniStopList(), geniStopKeyboard());
});

bot.action("geni:safety", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniSafety(), geniSafetyKeyboard());
});

bot.action(/^geni:safety:(loose|normal|strict)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const preset = ctx.match[1] as "loose" | "normal" | "strict";
  const updated = geniSettingsForPreset(preset);
  await store.updateGeniSettings(updated);
  await addAdminAudit({
    adminId: ctx.from.id,
    action: "geni_safety_preset",
    targetType: "geni",
    note: preset
  });
  await ctx.answerCbQuery(`Safety set to ${preset}.`);
  await showScreen(ctx, formatGeniSafety(), geniSafetyKeyboard());
});

bot.action("geni:profit", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniProfitCalculator(), geniProfitKeyboard());
});

bot.action("geni:profit:edit", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  setGeniDraft(ctx.from.id, { step: "profit_cpm" });
  await showScreen(ctx, [
    "💹 Profit Check",
    "",
    "Step 1 of 4",
    "Shortener CPM koto?",
    "",
    "Example:",
    "3.5"
  ].join("\n"), geniProfitKeyboard());
});

bot.action("geni:fraud", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniFraudSettings(), geniFraudKeyboard());
});

bot.action(/^geni:fraud:(ip|device):(up|down)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const settings = geniSettings();
  const key = ctx.match[1] === "ip" ? "sameIpLimit" : "sameDeviceLimit";
  const delta = ctx.match[2] === "up" ? 1 : -1;
  const updated: GeniSettings = {
    ...settings,
    [key]: Math.max(1, Math.min(50, settings[key] + delta)),
    updatedAt: new Date().toISOString()
  };
  await store.updateGeniSettings(updated);
  await ctx.answerCbQuery("Fraud setting updated.");
  await showScreen(ctx, formatGeniFraudSettings(), geniFraudKeyboard());
});

bot.action(/^geni:fraud:(bot|direct):toggle$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const settings = geniSettings();
  const updated: GeniSettings = ctx.match[1] === "bot"
    ? { ...settings, blockBotUserAgents: !settings.blockBotUserAgents, updatedAt: new Date().toISOString() }
    : { ...settings, flagDirectFinalHits: !settings.flagDirectFinalHits, updatedAt: new Date().toISOString() };
  await store.updateGeniSettings(updated);
  await ctx.answerCbQuery("Fraud setting updated.");
  await showScreen(ctx, formatGeniFraudSettings(), geniFraudKeyboard());
});

bot.action("geni:cancel", async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  geniDrafts.delete(ctx.from.id);
  await ctx.answerCbQuery("Cancelled");
  await showScreen(ctx, formatGeniSimpleHome(), geniSimpleKeyboard());
});

bot.action(/^geni:link:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const link = store.snapshot().geniLinks.find((item) => item.id === ctx.match[1]);
  if (!link) {
    await ctx.answerCbQuery("GENI link not found.", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniLinkDetail(link), geniLinkKeyboard(link));
});

bot.action(/^geni:urls:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const link = store.snapshot().geniLinks.find((item) => item.id === ctx.match[1]);
  if (!link) {
    await ctx.answerCbQuery("GENI link not found.", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await showScreen(ctx, formatGeniLinkUrls(link), geniMoreKeyboard(link));
});

bot.action(/^geni:shortener:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const link = store.snapshot().geniLinks.find((item) => item.id === ctx.match[1]);
  if (!link) {
    await ctx.answerCbQuery("GENI link not found.", { show_alert: true });
    return;
  }
  setGeniDraft(ctx.from.id, { step: "shortener", linkId: link.id, name: link.name });
  await ctx.answerCbQuery();
  await showScreen(ctx, [
    "🔗 Add Shortener URL",
    "",
    `Link: ${link.name}`,
    "",
    "First use this Final URL as the destination in your paid shortener:",
    geniFinalUrl(link.id),
    "",
    "Then send the shortener URL here.",
    "Send skip to leave it empty."
  ].join("\n"), geniCancelKeyboard(link.id));
});

bot.action(/^geni:(pause|resume|archive):(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const action = ctx.match[1];
  const link = store.snapshot().geniLinks.find((item) => item.id === ctx.match[2]);
  if (!link) {
    await ctx.answerCbQuery("GENI link not found.", { show_alert: true });
    return;
  }

  const status = action === "pause" ? "paused" : action === "resume" ? "active" : "archived";
  const updated: GeniLink = {
    ...link,
    status,
    updatedAt: new Date().toISOString()
  };
  await store.upsertGeniLink(updated);
  await addAdminAudit({
    adminId: ctx.from.id,
    action: `geni_${action}`,
    targetType: "geni_link",
    targetId: updated.id,
    note: updated.name
  });
  await ctx.answerCbQuery(`GENI link ${status}.`);
  await showScreen(ctx, formatGeniLinkDetail(updated), geniLinkKeyboard(updated));
});

bot.action(/^geni:quick_stop:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "geni"))) return;
  const link = store.snapshot().geniLinks.find((item) => item.id === ctx.match[1]);
  if (!link) {
    await ctx.answerCbQuery("GENI link not found.", { show_alert: true });
    return;
  }
  const updated: GeniLink = {
    ...link,
    status: "paused",
    updatedAt: new Date().toISOString()
  };
  await store.upsertGeniLink(updated);
  await addAdminAudit({
    adminId: ctx.from.id,
    action: "geni_quick_stop",
    targetType: "geni_link",
    targetId: updated.id,
    note: updated.name
  });
  await ctx.answerCbQuery("Link stopped.");
  await showScreen(ctx, formatGeniStopList(), geniStopKeyboard());
});

bot.on("channel_post", async (ctx) => {
  const post = (ctx as unknown as { channelPost?: { chat: { id: number }; text?: string } }).channelPost;
  const text = post?.text?.trim();
  if (!post || !text) return;

  if (text === "/chatid" || text.startsWith("/chatid@")) {
    await ctx.telegram.sendMessage(post.chat.id, `Chat ID: ${post.chat.id}`);
    return;
  }

  if (config.adminPanelChannelId && post.chat.id === config.adminPanelChannelId && (text === "/refresh" || text.startsWith("/refresh@"))) {
    const count = await refreshAdminPanelMessages();
    await ctx.telegram.sendMessage(post.chat.id, `Panel refreshed. Pending withdrawals: ${count}`);
  }
});

bot.on("my_chat_member", async (ctx) => {
  const update = ctx.myChatMember;
  const chat = update.chat;
  const status = update.new_chat_member.status;
  const newChatMember = update.new_chat_member as { status: string; can_invite_users?: boolean };
  const canVerifyMembers = status === "administrator" || status === "creator";
  const canInviteUsers = status === "creator" || (status === "administrator" && newChatMember.can_invite_users !== false);
  const trackedChat: TrackedChat = {
    id: chat.id,
    title: "title" in chat ? chat.title : undefined,
    type: chat.type as TrackedChat["type"],
    botStatus: status,
    canVerifyMembers,
    canInviteUsers: canVerifyMembers && canInviteUsers,
    updatedAt: new Date().toISOString()
  };
  await store.upsertTrackedChat(trackedChat);
  await notifyWaitingDraftsForChat(trackedChat);
});

bot.on("chat_member", async (ctx) => {
  await handleTelegramMembershipUpdate(ctx);
});

bot.action(/^mode:(freelancer|buyer)$/, async (ctx) => {
  const mode = ctx.match[1] as "freelancer" | "buyer";
  const user = await ensureUser(ctx.from);
  const updatedUser = switchMode(user, mode);
  await store.upsertUser(updatedUser);
  await ctx.answerCbQuery(`Mode changed to ${mode}`);
  await showScreen(ctx, user.language === "bn" ? `ওয়ার্কস্পেস পরিবর্তন হয়েছে: ${formatMode(mode, user.language)}` : `Workspace changed: ${formatMode(mode, user.language)}`, mainMenu(updatedUser));
});

bot.action(/^wizard:approval:(manual|auto)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }

  draft.approvalType = ctx.match[1] as TaskApprovalType;
  draft.step = "reward";
  taskDrafts.set(ctx.from.id, draft);
  await showScreen(ctx, rewardPrompt(draft.category, store.snapshot().users.find((item) => item.id === ctx.from.id)?.language, messages));
});

bot.action(/^wizard:type:(telegram_join|website_visit|quiz|manual_proof|app_task|custom)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }

  applyTaskTypeTemplate(draft, ctx.match[1]);
  taskDrafts.set(ctx.from.id, draft);

  if (draft.verificationType) {
    await showScreen(ctx, verificationTargetPrompt(draft.verificationType, messages));
    return;
  }

  await showScreen(ctx, messages.taskWizard.enterTitle);
});

bot.action(/^wizard:coming_soon:(app|social|survey|data_entry|review|quiz|custom)$/, async (ctx) => {
  const user = await ensureUser(ctx.from);
  const label = categoryLabel(ctx.match[1], user.language);
  await ctx.answerCbQuery(user.language === "bn" ? `${label} শিগগির আসছে` : `${label} is coming soon`);
  await showScreen(ctx, user.language === "bn" ? `${label} ক্যাটাগরি শিগগির আসছে।` : `${label} category is coming soon.`, taskCategoryKeyboard(getMessages(user.language)));
});

bot.action(/^wizard:category:(telegram|website|app|social|survey|data_entry|review|quiz|custom)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }

  draft.category = ctx.match[1];
  if (!ACTIVE_TASK_CATEGORIES.has(draft.category)) {
    const label = categoryLabel(draft.category, store.snapshot().users.find((item) => item.id === ctx.from.id)?.language);
    await showScreen(ctx, `${label} category is coming soon.`, taskCategoryKeyboard(messages));
    return;
  }

  applyCategoryTemplate(draft, draft.category);
  taskDrafts.set(ctx.from.id, draft);
  await showScreen(ctx, messages.taskWizard.chooseVerification, verificationMethodKeyboard(draft.category, messages));
});

bot.action(/^wizard:website_timer:(30|60|120|custom)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft || draft.category !== "website") {
    await ctx.reply(messages.common.draftExpired);
    return;
  }

  if (ctx.match[1] === "custom") {
    draft.step = "website_timer";
    taskDrafts.set(ctx.from.id, draft);
    await showScreen(ctx, messages.taskWizard.websiteTimerPrompt);
    return;
  }

  draft.websiteVisitSeconds = Number(ctx.match[1]);
  draft.step = "target";
  taskDrafts.set(ctx.from.id, draft);
  await showScreen(ctx, targetPromptForDraft(draft, messages));
});

bot.action(/^wizard:method:(auto_join|timer_visit|quiz_answer|manual_proof|webhook|app_tracking|in_app_code)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft?.category) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }

  applyVerificationMethod(draft, ctx.match[1]);
  taskDrafts.set(ctx.from.id, draft);

  if (draft.verificationType === "website_visit") {
    await showScreen(ctx, messages.taskWizard.websiteTimerPrompt, websiteTimerKeyboard(messages));
    return;
  }

  if (draft.verificationType) {
    await showScreen(ctx, verificationTargetPrompt(draft.verificationType, messages));
    return;
  }

  await showScreen(ctx, targetPromptForDraft(draft, messages));
});

bot.action("wizard:instruction:skip", async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }
  draft.step = "confirm";
  taskDrafts.set(ctx.from.id, draft);
  await showScreen(ctx, formatDraftReview(draft, messages, store.snapshot().users.find((item) => item.id === ctx.from.id)?.language), confirmTaskKeyboard(messages));
});

bot.action("wizard:instruction:edit", async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }
  draft.step = "instructions";
  taskDrafts.set(ctx.from.id, draft);
  await showScreen(ctx, messages.taskWizard.editInstruction);
});

bot.action(/^wizard:verification:(telegram_join|website_visit|website_webhook|app_attribution|in_app_code|quiz)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const messages = userMessages(ctx.from.id);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(messages.common.draftExpired);
    return;
  }

  draft.verificationType = ctx.match[1] as VerificationType;
  draft.step = "target";
  taskDrafts.set(ctx.from.id, draft);
  await showScreen(ctx, verificationTargetPrompt(draft.verificationType, messages));
});

bot.action("wizard:confirm", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const messages = getMessages(user.language);
  const draft = getTaskDraft(ctx.from.id);
  if (!draft || !isCompleteDraft(draft)) {
    await ctx.reply(messages.common.incompleteDraft);
    return;
  }

  const task = withTaskTargetMetadata(createTask({
    buyerId: user.id,
    title: draft.title,
    category: draft.category,
    instructions: draft.instructions,
    rewardPerWorker: draft.rewardPerWorker,
    workerLimit: draft.workerLimit,
    approvalType: draft.approvalType,
    verificationType: draft.verificationType,
    verificationTarget: draft.verificationTarget,
    websiteVisitSeconds: draft.websiteVisitSeconds
  }));
  try {
    assertCampaignTargetAllowed(task);
    assertEnoughWithdrawableForEscrow(user.id, escrowRequired(task), user.language);
  } catch (error) {
    await ctx.reply((error as Error).message);
    return;
  }

  await store.addTask(task);
  await store.addTransaction(createTransaction({
    userId: user.id,
    type: "escrow_lock",
    amount: escrowRequired(task),
    taskId: task.id,
    note: "MVP records escrow lock. Connect deposit validation before public launch."
  }));
  taskDrafts.delete(ctx.from.id);

  await ctx.reply(`${messages.taskWizard.published}\n\n${formatTask(task, user.language)}\n\n${messages.wallet.escrowLocked} ${formatMoneyDetail(escrowRequired(task), user.language)}`, taskHtmlExtra(mainMenu(user)));
});

bot.action("wizard:cancel", async (ctx) => {
  await ctx.answerCbQuery();
  taskDrafts.delete(ctx.from.id);
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, getMessages(user.language).taskWizard.cancelled, mainMenu(user));
});

bot.action(/^submission:view:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const submission = store.snapshot().submissions.find((item) => item.id === ctx.match[1]);
  if (!submission) {
    await ctx.reply("Submission not found.");
    return;
  }

  const task = store.snapshot().tasks.find((item) => item.id === submission.taskId);
  if (!task) {
    await ctx.reply("Task not found.");
    return;
  }

  if (task.buyerId !== user.id && !(isAdminUser(user.id) && hasAdminPermission(user.id, "review"))) {
    await ctx.reply("You do not have permission to view this submission.");
    return;
  }

  await sendSubmissionReview(ctx, submission.id);
});

bot.action(/^campaign:view:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const task = getReviewableTask(ctx.match[1], user.id);
    await showScreen(ctx, formatCampaignDetail(task.id, user.language), taskHtmlExtra(campaignActionKeyboard(task.id, task.status, user.language)));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^campaign:pause:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const task = await updateCampaignStatus(ctx.match[1], user.id, "paused");
    await showScreen(ctx, `${getMessages(user.language).campaigns.paused} ${task.title}`, campaignActionKeyboard(task.id, task.status, user.language));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^campaign:resume:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const task = await updateCampaignStatus(ctx.match[1], user.id, "active");
    await showScreen(ctx, `${getMessages(user.language).campaigns.resumed} ${task.title}`, campaignActionKeyboard(task.id, task.status, user.language));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^campaign:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const result = await cancelCampaign(ctx.match[1], user.id);
    await showScreen(ctx, `Campaign cancelled: ${result.task.title}\nRefunded: ${result.refundAmount} BDT`, campaignHistoryKeyboard(user.language));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^submission:approve:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const result = await approveSubmissionById(ctx.match[1], ctx.from.id);
    await ctx.reply(`Approved. Worker ${result.workerId} earned ${result.rewardAmount} BDT.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^submission:reject:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const submission = await rejectSubmissionById(ctx.match[1], "Rejected by reviewer", ctx.from.id);
    await ctx.reply(`Rejected ${submission.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^withdrawal:pay:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(ctx.from && isAdminPanelCallbackContext(ctx) && hasAdminPermission(ctx.from.id, "finance"))) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const withdrawal = await payWithdrawalById(ctx.match[1]);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "pay_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: `${withdrawal.amount} BDT`
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "paid");
    await ctx.reply(`Withdrawal paid: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^deposit:approve:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(ctx.from && isAdminPanelCallbackContext(ctx) && hasAdminPermission(ctx.from.id, "finance"))) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const deposit = await approveDepositById(ctx.match[1]);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "approve_deposit",
      targetType: "deposit",
      targetId: deposit.id,
      note: `${deposit.amount} BDT`
    });
    await ctx.reply(`Deposit approved. User ${deposit.userId} received ${deposit.amount} BDT.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^deposit:reject:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(ctx.from && isAdminPanelCallbackContext(ctx) && hasAdminPermission(ctx.from.id, "finance"))) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const deposit = await rejectDepositById(ctx.match[1], "Rejected by admin");
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "reject_deposit",
      targetType: "deposit",
      targetId: deposit.id,
      note: "Rejected by admin"
    });
    await ctx.reply(`Deposit rejected: ${deposit.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^dispute:pay:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(ctx.from && isAdminPanelCallbackContext(ctx) && hasAdminPermission(ctx.from.id, "review"))) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const dispute = await resolveDisputePayWorker(ctx.match[1]);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "resolve_dispute",
      targetType: "dispute",
      targetId: dispute.id,
      note: dispute.status
    });
    await ctx.reply(`Dispute resolved. Worker paid for ${dispute.submissionId}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^dispute:uphold:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(ctx.from && isAdminPanelCallbackContext(ctx) && hasAdminPermission(ctx.from.id, "review"))) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const dispute = await resolveDisputeUphold(ctx.match[1]);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "resolve_dispute",
      targetType: "dispute",
      targetId: dispute.id,
      note: dispute.status
    });
    await ctx.reply(`Dispute resolved. Rejection upheld for ${dispute.submissionId}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^withdrawal:reject:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(ctx.from && isAdminPanelCallbackContext(ctx) && hasAdminPermission(ctx.from.id, "finance"))) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const withdrawal = await rejectWithdrawalById(ctx.match[1], "Rejected by admin");
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "reject_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: "Rejected by admin"
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "rejected");
    await ctx.reply(`Withdrawal rejected: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^admin:withdraw:pay:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;

  try {
    const withdrawal = await payWithdrawalById(ctx.match[1]);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "pay_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: `${withdrawal.amount} BDT`
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "paid");
    await ctx.answerCbQuery("Withdrawal marked paid.");
  } catch (error) {
    await ctx.answerCbQuery((error as Error).message, { show_alert: true });
  }
});

bot.action(/^admin:withdraw:reject_menu:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;

  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === ctx.match[1]);
  if (!withdrawal) {
    await ctx.answerCbQuery("Withdrawal not found.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(adminWithdrawalKeyboard(withdrawal, true).reply_markup);
});

bot.action(/^admin:withdraw:reject:(.+):(wrong_account|suspicious|duplicate|user_request)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;

  const reason = withdrawalPresetRejectReason(ctx.match[2]);
  try {
    const withdrawal = await rejectWithdrawalById(ctx.match[1], reason);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "reject_withdrawal",
      targetType: "withdrawal",
      targetId: withdrawal.id,
      note: reason
    });
    await syncWithdrawalPanelMessages(withdrawal.id);
    await notifyWithdrawalUser(withdrawal, "rejected");
    await ctx.answerCbQuery("Withdrawal rejected.");
  } catch (error) {
    await ctx.answerCbQuery((error as Error).message, { show_alert: true });
  }
});

bot.action(/^admin:withdraw:custom:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;

  const command = `/rejectwd ${ctx.match[1]} <reason>`;
  await ctx.answerCbQuery(`Use console group: ${command}`, { show_alert: true });
});

bot.action(/^admin:withdraw:back:(.+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "finance"))) return;

  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === ctx.match[1]);
  if (!withdrawal) {
    await ctx.answerCbQuery("Withdrawal not found.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(adminWithdrawalKeyboard(withdrawal).reply_markup);
});

bot.action(/^admin:withdraw:user:(\d+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "users"))) return;

  await ctx.answerCbQuery();
  await ctx.reply(formatUserLookup(Number(ctx.match[1])));
});

bot.action(/^admin:withdraw:history:(\d+)$/, async (ctx) => {
  if (!(await requireAdminPanelCallback(ctx, "users"))) return;

  await ctx.answerCbQuery();
  await ctx.reply(formatAdminWithdrawalHistory(Number(ctx.match[1])));
});

bot.action(/^task:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  const task = store.snapshot().tasks.find((item) => item.id === ctx.match[1]);
  if (!task) {
    await ctx.reply("Task not found.");
    return;
  }
  const user = await ensureUser(ctx.from);
  await showScreen(ctx, await formatTaskForUser(ctx, task, user), taskHtmlExtra(taskActionButtons(task, user.language)));
});

bot.action(/^proof:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  proofWaiters.set(ctx.from.id, ctx.match[1]);
  await ctx.reply("Send proof now: screenshot caption, text, username, or link. Your next message will be saved as proof.");
});

bot.action(/^verify:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  const cooldownKey = `${ctx.from.id}:${ctx.match[1]}`;
  const lastVerifyAt = verifyCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastVerifyAt < VERIFY_COOLDOWN_MS) {
    await ctx.reply("Please wait. Verify Now has a 15-second cooldown.");
    return;
  }
  verifyCooldowns.set(cooldownKey, Date.now());
  const task = store.snapshot().tasks.find((item) => item.id === ctx.match[1]);
  if (!task) {
    await ctx.reply("Task not found.");
    return;
  }

  if (task.verificationType === "telegram_join") {
    await verifyTelegramJoin(ctx, task.id);
    return;
  }

  if (task.verificationType === "website_visit") {
    await verifyWebsiteVisit(ctx, task.id);
    return;
  }

  if (task.verificationType === "quiz") {
    quizWaiters.set(ctx.from.id, task.id);
    await ctx.reply("Send the quiz answer/code. Correct answers are rewarded instantly.");
    return;
  }

  if (task.verificationType === "in_app_code") {
    codeWaiters.set(ctx.from.id, task.id);
    await ctx.reply("Send the in-app verification code. Correct codes are rewarded instantly.");
    return;
  }

  if (task.verificationType === "website_webhook" || task.verificationType === "app_attribution") {
    await ctx.reply([
      "This task is verified by the buyer's API/webhook.",
      "Complete the required action on the website/app. Neosence will pay automatically when the buyer system confirms it."
    ].join("\n"));
    return;
  }

  await ctx.reply("This auto verification integration is not connected yet. Telegram join, website timer, in-app code, and webhook/API verification are ready now.");
});

bot.on("message", async (ctx, next) => {
  if (!ctx.from) return next();
  const payoutSetup = payoutSetupWaiters.get(ctx.from.id);
  if (payoutSetup) {
    await handlePayoutAccountMessage(ctx, payoutSetup);
    return;
  }

  if (customWithdrawWaiters.has(ctx.from.id)) {
    await handleCustomWithdrawAmount(ctx);
    return;
  }

  const quizTaskId = quizWaiters.get(ctx.from.id);
  if (quizTaskId) {
    await handleQuizAnswer(ctx, quizTaskId);
    return;
  }

  const codeTaskId = codeWaiters.get(ctx.from.id);
  if (codeTaskId) {
    await handleInAppCodeAnswer(ctx, codeTaskId);
    return;
  }

  if (supportWaiters.has(ctx.from.id)) {
    await handleSupportMessage(ctx);
    return;
  }

  const geniDraft = geniDrafts.get(ctx.from.id);
  if (geniDraft && isAdminConsoleCommandContext(ctx)) {
    await handleGeniDraftMessage(ctx, geniDraft);
    return;
  }

  const draft = getTaskDraft(ctx.from.id);
  if (draft) {
    await handleTaskWizardMessage(ctx, draft);
    return;
  }

  const messageText = extractText(ctx.message);
  if (messageText?.startsWith("/")) {
    await ctx.reply(isAdminConsoleCommandContext(ctx)
      ? "I did not understand this admin command.\n\nUse /help to see all admin commands."
      : "I did not understand this command.\n\nUse /start or the buttons to continue.");
    return;
  }

  const taskId = proofWaiters.get(ctx.from.id);
  if (!taskId) return next();

  const state = store.snapshot();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    proofWaiters.delete(ctx.from.id);
    await ctx.reply("Task not found.");
    return;
  }

  const proof = extractProof(ctx.message);
  const submission = createSubmission(task, ctx.from.id, proof);
  await store.addSubmission(submission);
  proofWaiters.delete(ctx.from.id);
  await ctx.reply(`Proof submitted. Submission ID: ${submission.id}. Status: ${submission.status}`);
});

interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
}

async function ensureUser(from: TelegramFrom) {
  const user = getOrCreateUser(store.snapshot(), from);
  await store.upsertUser(user);
  return user;
}

function userMessages(userId: number) {
  const user = store.snapshot().users.find((item) => item.id === userId);
  return getMessages(user?.language);
}

function adminUnknownCommandText(): string {
  return "I did not understand this command.\n\nAdmin actions are available only inside the configured admin console group.";
}

type AdminPermission = "dashboard" | "admin_management" | "finance" | "review" | "support" | "users" | "moderation" | "settings" | "geni";

function adminRole(userId: number): AdminRole | undefined {
  if (isAdmin(userId)) return "owner";
  const member = store.snapshot().adminMembers.find((item) => item.userId === userId && item.active);
  return member?.role;
}

function isAdminUser(userId: number): boolean {
  return Boolean(adminRole(userId));
}

function adminRoleLabel(role: AdminRole): string {
  if (role === "owner") return "Owner";
  if (role === "manager") return "Manager";
  if (role === "finance") return "Finance";
  if (role === "reviewer") return "Reviewer";
  return "Support";
}

function parseAdminRole(value: string | undefined): AdminRole | undefined {
  if (value === "owner" || value === "manager" || value === "finance" || value === "reviewer" || value === "support") return value;
  return undefined;
}

function hasAdminPermission(userId: number, permission: AdminPermission): boolean {
  const role = adminRole(userId);
  if (!role) return false;
  if (role === "owner") return true;
  if (role === "manager") return permission !== "admin_management" && permission !== "settings";
  if (role === "finance") return ["dashboard", "finance", "users"].includes(permission);
  if (role === "reviewer") return ["dashboard", "review", "users"].includes(permission);
  return ["dashboard", "support", "users"].includes(permission);
}

async function setAdminMember(userId: number, role: AdminRole, actorId: number, active: boolean): Promise<AdminMember> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid Telegram user ID.");
  if (isAdmin(userId) && role !== "owner") throw new Error("Env owner role cannot be changed.");

  const now = new Date().toISOString();
  const existing = store.snapshot().adminMembers.find((item) => item.userId === userId);
  const member: AdminMember = {
    userId,
    role: isAdmin(userId) ? "owner" : role,
    active,
    addedBy: existing?.addedBy ?? actorId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await store.upsertAdminMember(member);
  return member;
}

async function removeAdminMember(userId: number): Promise<AdminMember> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid Telegram user ID.");
  if (isAdmin(userId)) throw new Error("Env owner cannot be removed from the admin panel.");

  const existing = store.snapshot().adminMembers.find((item) => item.userId === userId);
  if (!existing || !existing.active) throw new Error("Active admin not found.");

  const member: AdminMember = {
    ...existing,
    active: false,
    updatedAt: new Date().toISOString()
  };
  await store.upsertAdminMember(member);
  return member;
}

function isAdminConsoleCommandContext(ctx: Context): boolean {
  return Boolean(
    ctx.from &&
    isAdminUser(ctx.from.id) &&
    config.adminConsoleGroupId &&
    ctx.chat?.id === config.adminConsoleGroupId
  );
}

async function requireAdminConsole(ctx: Context, permission: AdminPermission = "dashboard"): Promise<boolean> {
  if (isAdminConsoleCommandContext(ctx) && ctx.from && hasAdminPermission(ctx.from.id, permission)) return true;
  if (isAdminConsoleCommandContext(ctx)) {
    await ctx.reply("You do not have permission for this admin action.");
    return false;
  }
  if (ctx.from) {
    await ctx.reply(isAdminUser(ctx.from.id)
      ? adminUnknownCommandText()
      : "I did not understand this command.\n\nUse /start or the buttons to continue.");
  }
  return false;
}

function isAdminPanelCallbackContext(ctx: Context): boolean {
  const messageChatId = (ctx.callbackQuery?.message as { chat?: { id?: number } } | undefined)?.chat?.id;
  return Boolean(
    ctx.from &&
    isAdminUser(ctx.from.id) &&
    (
      (config.adminConsoleGroupId && messageChatId === config.adminConsoleGroupId) ||
      (config.adminPanelChannelId && messageChatId === config.adminPanelChannelId)
    )
  );
}

async function requireAdminPanelCallback(ctx: Context, permission: AdminPermission = "dashboard"): Promise<boolean> {
  if (isAdminPanelCallbackContext(ctx) && ctx.from && hasAdminPermission(ctx.from.id, permission)) return true;
  if (isAdminPanelCallbackContext(ctx)) {
    await ctx.answerCbQuery("You do not have permission for this action.", { show_alert: true });
    return false;
  }
  await ctx.answerCbQuery("Admin panel access required.", { show_alert: true });
  return false;
}

async function addAdminAudit(input: {
  adminId: number;
  action: string;
  targetType?: string;
  targetId?: string;
  note?: string;
}) {
  const event: AdminAuditEvent = {
    id: localId("audit"),
    adminId: input.adminId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    note: input.note,
    createdAt: new Date().toISOString()
  };
  await store.addAdminAuditEvent(event);
}

async function showScreen(ctx: Context, text: string, extra?: ReplyMarkup) {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, extra as Parameters<Context["editMessageText"]>[1]);
      rememberActiveScreen(ctx);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("message is not modified")) {
        console.warn("Falling back to reply for screen update", message);
      } else {
        return;
      }
    }
  }

  const sent = await ctx.reply(text, extra);
  if (ctx.from && "message_id" in sent) {
    activeScreenMessages.set(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id });
  }
}

function rememberActiveScreen(ctx: Context) {
  const message = ctx.callbackQuery?.message;
  if (!ctx.from || !message) return;
  activeScreenMessages.set(ctx.from.id, { chatId: message.chat.id, messageId: message.message_id });
}

async function showFlowScreen(ctx: Context & { from: TelegramFrom }, text: string, extra?: ReplyMarkup) {
  const active = activeScreenMessages.get(ctx.from.id);
  if (active) {
    try {
      await ctx.telegram.editMessageText(active.chatId, active.messageId, undefined, text, extra as Parameters<typeof ctx.telegram.editMessageText>[4]);
      return;
    } catch (error) {
      console.warn("Falling back to reply for flow screen", error instanceof Error ? error.message : String(error));
    }
  }

  await showScreen(ctx, text, extra);
}

async function deleteUserInputMessage(ctx: Context) {
  try {
    await ctx.deleteMessage();
  } catch {
    // Some chats do not allow deleting user messages; clean screen editing still works.
  }
}

function homeText(user: { mode: "freelancer" | "buyer"; language: "en" | "bn" }) {
  const messages = getMessages(user.language);
  return [
    messages.start.welcome,
    "",
    `${messages.start.currentWorkspace} ${formatMode(user.mode, user.language)}.`
  ].join("\n");
}

function homeKeyboard(user: { language: "en" | "bn" }) {
  const messages = getMessages(user.language);
  return Markup.inlineKeyboard([[Markup.button.callback(messages.common.back, "menu:home")]]);
}

function walletLabels(language?: "en" | "bn") {
  if (language === "bn") {
    return {
      deposit: "ডিপোজিট",
      postTask: "টাস্ক পোস্ট",
      campaigns: "ক্যাম্পেইন",
      withdrawAll: "সব উইথড্র",
      customAmount: "কাস্টম অ্যামাউন্ট",
      changePayout: "পেআউট পরিবর্তন",
      setPayout: "পেআউট সেট",
      withdrawalHistory: "উইথড্র হিস্ট্রি",
      payout: "পেআউট",
      notSet: "সেট করা হয়নি",
      noPayoutSaved: "পেআউট মেথড সেভ করা নেই। একবার বেছে নিন:",
      confirmWithdraw: "উইথড্র কনফার্ম",
      customWithdraw: "কাস্টম উইথড্র",
      sendAmount: "অ্যামাউন্ট পাঠান। যেমন: 500",
      invalidAmount: "সঠিক অ্যামাউন্ট পাঠান। যেমন: 500",
      withdrawRequest: "উইথড্র রিকোয়েস্ট",
      amount: "অ্যামাউন্ট",
      method: "মেথড",
      fee: "ফি",
      receive: "আপনি পাবেন",
      payoutSaved: "পেআউট সেভ হয়েছে",
      insufficientBalance: "উইথড্র করার মতো যথেষ্ট ব্যালেন্স নেই।",
      noWithdrawableBalance: "এখন উইথড্র করার মতো কোনো ব্যালেন্স নেই।",
      amountTooLow: "পেআউট ফি কাটার পর অ্যামাউন্ট খুব কম।",
      withdrawSubmitted: "✅ উইথড্র রিকোয়েস্ট জমা হয়েছে",
      noWithdrawals: "এখনও কোনো উইথড্র নেই।",
      depositHelp: "ডিপোজিট করতে /depositreq কমান্ড ব্যবহার করুন।\n\nফরম্যাট:\n/depositreq 500 bkash trxid-or-proof-note",
      escrowInsufficient: "টাস্ক পাবলিশ করার মতো withdrawable balance নেই। Hold/Pending ব্যালেন্স ব্যবহার করা যাবে না।",
      hint: "পেন্ডিং/হোল্ড ব্যালেন্স খরচ বা উইথড্র করা যাবে না।"
    };
  }

  return {
    deposit: "Deposit",
    postTask: "Post Task",
    campaigns: "Campaigns",
    withdrawAll: "Withdraw All",
    customAmount: "Custom Amount",
    changePayout: "Change Payout",
    setPayout: "Set Payout",
    withdrawalHistory: "Withdrawal History",
    payout: "Payout",
    notSet: "Not set",
    noPayoutSaved: "No payout method saved. Choose once:",
    confirmWithdraw: "Confirm Withdraw",
    customWithdraw: "Custom Withdraw",
    sendAmount: "Send amount in BDT. Example: 500",
    invalidAmount: "Enter a valid amount in BDT. Example: 500",
    withdrawRequest: "Withdraw Request",
    amount: "Amount",
    method: "Method",
    fee: "Fee",
    receive: "You receive",
    payoutSaved: "Payout saved",
    insufficientBalance: "Insufficient withdrawable balance.",
    noWithdrawableBalance: "No withdrawable balance available right now.",
    amountTooLow: "Amount is too low after payout fee.",
    withdrawSubmitted: "✅ Withdrawal request submitted",
    noWithdrawals: "No withdrawals yet.",
    depositHelp: "Use /depositreq to request a deposit.\n\nFormat:\n/depositreq 500 bkash trxid-or-proof-note",
    escrowInsufficient: "Not enough withdrawable balance to publish this task. Hold/pending balance cannot be used.",
    hint: "Pending/Hold balance cannot be withdrawn or spent."
  };
}

function walletKeyboard(user: { mode: "freelancer" | "buyer"; language: "en" | "bn"; payoutMethod?: unknown }) {
  const messages = getMessages(user.language);
  const labels = walletLabels(user.language);
  if (user.mode === "buyer") {
    return Markup.inlineKeyboard([
      [Markup.button.callback(labels.deposit, "wallet:deposit_help")],
      [Markup.button.callback(labels.postTask, "menu:post"), Markup.button.callback(labels.campaigns, "menu:campaigns")],
      [Markup.button.callback(messages.common.back, "menu:home")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(labels.withdrawAll, "withdraw:all"), Markup.button.callback(labels.customAmount, "withdraw:custom")],
    [Markup.button.callback(user.payoutMethod ? labels.changePayout : labels.setPayout, "withdraw:change_payout")],
    [Markup.button.callback(labels.withdrawalHistory, "withdraw:history")],
    [Markup.button.callback(messages.common.back, "menu:home")]
  ]);
}

async function showEarn(ctx: Context & { from: TelegramFrom }) {
  const userId = ctx.from.id;
  const user = store.snapshot().users.find((item) => item.id === userId);
  const messages = userMessages(userId);
  const tasks = visibleTasks(store.snapshot(), userId);
  if (tasks.length === 0) {
    await showScreen(ctx, messages.common.noTasksAvailable, user ? homeKeyboard(user) : undefined);
    return;
  }
  await showScreen(ctx, messages.earn.chooseCategory, earnCategoryKeyboard(tasks, user?.language));
}

async function showEarnCategory(ctx: Context & { from: TelegramFrom }, category: string) {
  const allTasks = visibleTasks(store.snapshot(), ctx.from.id);
  const skipped = earnSkips.get(earnSkipKey(ctx.from.id, category)) ?? new Set<string>();
  const filtered = (category === "all" ? allTasks : allTasks.filter((task) => task.category === category))
    .filter((task) => !skipped.has(task.id));
  const messages = userMessages(ctx.from.id);
  const user = store.snapshot().users.find((item) => item.id === ctx.from.id);
  if (filtered.length === 0) {
    const rows = [
      skipped.size > 0 ? [Markup.button.callback(user?.language === "bn" ? "স্কিপ করা টাস্ক দেখান" : "Show skipped again", `earn:reset:${category}`)] : undefined,
      [Markup.button.callback(messages.earn.backToCategories, "earn:categories")],
      ...(user ? [[Markup.button.callback(messages.common.back, "menu:home")]] : [])
    ].filter((row): row is Array<ReturnType<typeof Markup.button.callback>> => Boolean(row));
    await showScreen(ctx, messages.earn.noCategoryTasks, Markup.inlineKeyboard(rows));
    return;
  }

  const task = rankEarnTasks(filtered)[0];
  const text = user ? await formatTaskForUser(ctx, task, user) : formatEarnFeedTask(task, category);
  await showScreen(ctx, text, taskHtmlExtra(earnFeedKeyboard(task, category, messages, user)));
}

function formatWallet(userId: number, mode: "freelancer" | "buyer", language?: "en" | "bn"): string {
  const messages = getMessages(language);
  const labels = walletLabels(language);
  const user = store.snapshot().users.find((item) => item.id === userId);
  const wallet = walletSummary(store.snapshot(), userId);
  const hold = Math.max(wallet.available - wallet.withdrawable, 0);
  const payout = user?.payoutMethod ? formatSavedPayout(user.payoutMethod.type, user.payoutMethod.account) : labels.notSet;

  return [
    mode === "buyer" ? messages.wallet.buyerTitle : messages.wallet.freelancerTitle,
    "",
    labelWithoutColon(messages.wallet.available),
    formatMoney(wallet.available, language),
    "",
    labelWithoutColon(messages.wallet.withdrawable),
    formatMoney(wallet.withdrawable, language),
    "",
    `${messages.wallet.pending} ${formatMoney(wallet.pending, language)}`,
    `${messages.wallet.autoHold} ${formatMoney(hold, language)}`,
    `${messages.wallet.escrowLocked} ${formatMoney(wallet.escrow, language)}`,
    "",
    `${labels.payout}: ${payout}`,
    "",
    labels.hint
  ].join("\n");
}

function labelWithoutColon(label: string): string {
  return label.replace(/:$/, "");
}

function assertEnoughWithdrawableForEscrow(userId: number, requiredEscrow: number, language?: "en" | "bn") {
  const wallet = walletSummary(store.snapshot(), userId);
  if (wallet.withdrawable >= requiredEscrow) return;

  const labels = walletLabels(language);
  const messages = getMessages(language);
  throw new Error([
    labels.escrowInsufficient,
    "",
    `${messages.wallet.withdrawable} ${formatMoney(wallet.withdrawable, language)}`,
    `${messages.wallet.escrowLocked} ${formatMoneyDetail(requiredEscrow, language)}`
  ].join("\n"));
}

function formatMode(mode: "freelancer" | "buyer", language?: "en" | "bn"): string {
  if (language === "bn") return mode === "freelancer" ? "ফ্রিল্যান্সার মোড" : "বায়ার মোড";
  return mode === "freelancer" ? "Freelancer Mode" : "Buyer Mode";
}

const earnCategories = ["telegram", "website", "app", "social", "survey", "data_entry", "review", "quiz", "custom"];

function categoryLabel(category: string, language?: "en" | "bn"): string {
  const messages = getMessages(language);
  return messages.categories[category as keyof typeof messages.categories] ?? category;
}

function earnCategoryKeyboard(tasks: Task[], language?: "en" | "bn") {
  const rows = earnCategories
    .map((category) => {
      const count = tasks.filter((task) => task.category === category).length;
      return count > 0 ? [Markup.button.callback(`${categoryLabel(category, language)} (${count})`, `earn:category:${category}:0`)] : undefined;
    })
    .filter((row): row is Array<ReturnType<typeof Markup.button.callback>> => Boolean(row));
  rows.push([Markup.button.callback(`${categoryLabel("all", language)} Tasks (${tasks.length})`, "earn:category:all:0")]);
  return Markup.inlineKeyboard(rows);
}

function rankEarnTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => earnTaskScore(right) - earnTaskScore(left));
}

function earnTaskScore(task: Task): number {
  const remainingWorkers = Math.max(task.workerLimit - task.completedCount, 0);
  const availabilityBonus = Math.min(remainingWorkers / Math.max(task.workerLimit, 1), 1) * 5;
  const autoBonus = task.approvalType === "auto" ? 10 : 0;
  const freshnessBonus = Math.max(0, 5 - ageHours(task.createdAt) / 24);
  const nearFullPenalty = remainingWorkers <= 2 ? 8 : 0;
  const buyerTrustBonus = calculateTrustScore(store.snapshot(), task.buyerId).score / 10;
  return task.rewardPerWorker * 100 + buyerTrustBonus + autoBonus + availabilityBonus + freshnessBonus - nearFullPenalty;
}

function ageHours(value: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max((Date.now() - time) / (60 * 60 * 1000), 0);
}

function formatEarnFeedTask(task: Task, category: string, language?: "en" | "bn"): string {
  return formatTask(withTaskTargetMetadata(task), language);
}

async function formatTaskForUser(ctx: Context, task: Task, user: UserProfile): Promise<string> {
  const hydratedTask = withTaskTargetMetadata(task);
  if (isTelegramJoinTask(hydratedTask) && hydratedTask.buyerId !== user.id) {
    try {
      const inviteLink = await ensureTelegramInviteLink(ctx, hydratedTask, user.id);
      return formatTask(hydratedTask, user.language, {
        targetTitle: inviteLink.chatTitle ?? telegramTaskTargetTitle(hydratedTask),
        targetUrl: inviteLink.inviteLink,
        joinLabel: "Join"
      });
    } catch (error) {
      return [
        formatTask(hydratedTask, user.language, { targetTitle: telegramTaskTargetTitle(hydratedTask) }),
        "",
        user.language === "bn"
          ? `Join link ready করা যায়নি: ${escapeTelegramHtml((error as Error).message)}`
          : `Join link could not be prepared: ${escapeTelegramHtml((error as Error).message)}`
      ].join("\n");
    }
  }

  return formatTask(hydratedTask, user.language, {
    targetTitle: isTelegramJoinTask(hydratedTask) ? telegramTaskTargetTitle(hydratedTask) : undefined
  });
}

function withTaskTargetMetadata(task: Task): Task {
  if (isTelegramJoinTask(task)) {
    return {
      ...task,
      verificationTargetTitle: telegramTaskTargetTitle(task)
    };
  }

  if (task.category === "website" && task.verificationTarget) {
    return {
      ...task,
      verificationTargetUrl: task.verificationTarget
    };
  }

  return task;
}

function telegramTaskTargetTitle(task: Task): string {
  if (!task.verificationTarget) return task.verificationTargetTitle ?? "Telegram channel/group";
  const chatId = Number(task.verificationTarget);
  const chat = Number.isFinite(chatId)
    ? store.snapshot().trackedChats.find((item) => item.id === chatId)
    : undefined;
  return chat?.title ?? task.verificationTargetTitle ?? "Telegram channel/group";
}

function isTelegramJoinTask(task: Task): boolean {
  return task.category === "telegram" && task.verificationType === "telegram_join" && Boolean(task.verificationTarget);
}

async function ensureTelegramInviteLink(ctx: Context, task: Task, workerId: number): Promise<TelegramInviteLinkRecord> {
  const chatId = telegramChatIdFromTask(task);
  if (!chatId) throw new Error("Telegram chat ID missing.");

  await markExpiredTelegramInviteLinks();

  const nowTime = Date.now();
  const existing = store.snapshot().telegramInviteLinks.find((link) =>
    link.taskId === task.id &&
    link.workerId === workerId &&
    link.status === "pending" &&
    new Date(link.expiresAt).getTime() > nowTime
  );
  if (existing) return existing;

  const trackedChat = store.snapshot().trackedChats.find((chat) => chat.id === chatId);
  if (!trackedChat?.canVerifyMembers) {
    throw new Error("Bot admin access is missing for this channel/group.");
  }
  if (trackedChat.canInviteUsers === false) {
    throw new Error("Bot admin invite-link permission is missing.");
  }

  const expiresAtMs = nowTime + TELEGRAM_INVITE_LINK_TTL_MS;
  const result = await createTelegramInviteLink(ctx, chatId, task, workerId, expiresAtMs);
  const record: TelegramInviteLinkRecord = {
    id: localId("tginv"),
    taskId: task.id,
    workerId,
    chatId,
    inviteLink: result.invite_link,
    chatTitle: trackedChat.title ?? task.verificationTargetTitle,
    status: "pending",
    createdAt: new Date(nowTime).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
  await store.upsertTelegramInviteLink(record);
  return record;
}

async function createTelegramInviteLink(
  ctx: Context,
  chatId: number,
  task: Task,
  workerId: number,
  expiresAtMs: number
): Promise<{ invite_link: string }> {
  try {
    const result = await ctx.telegram.callApi("createChatInviteLink", {
      chat_id: chatId,
      name: `Neosence ${shortId(task.id)} ${workerId}`.slice(0, 32),
      expire_date: Math.floor(expiresAtMs / 1000),
      member_limit: 1,
      creates_join_request: false
    });
    return result as { invite_link: string };
  } catch (error) {
    const retryAfter = telegramRetryAfter(error);
    if (retryAfter) {
      throw new Error(`Telegram rate limit. Try again in ${retryAfter}s.`);
    }
    throw error;
  }
}

async function markExpiredTelegramInviteLinks() {
  const nowTime = Date.now();
  const expiredLinks = store.snapshot().telegramInviteLinks.filter((link) =>
    link.status === "pending" &&
    new Date(link.expiresAt).getTime() <= nowTime
  );

  for (const link of expiredLinks) {
    await store.upsertTelegramInviteLink({ ...link, status: "expired" });
  }
}

function telegramChatIdFromTask(task: Task): number | undefined {
  if (!task.verificationTarget) return undefined;
  const chatId = Number(task.verificationTarget);
  return Number.isFinite(chatId) ? chatId : undefined;
}

function telegramRetryAfter(error: unknown): number | undefined {
  const data = error as {
    parameters?: { retry_after?: number };
    response?: { parameters?: { retry_after?: number } };
  };
  return data.parameters?.retry_after ?? data.response?.parameters?.retry_after;
}

function escapeTelegramHtml(value: string): string {
  return escapeHtml(value);
}

function earnFeedKeyboard(task: Task, category: string, messages: MessageBundle = t, user?: { language: "en" | "bn" }) {
  const actionText = task.approvalType === "manual" ? messages.buttons.submitProof : messages.buttons.verifyNow;
  const rows = [
    [Markup.button.callback(actionText, task.approvalType === "manual" ? `proof:${task.id}` : `verify:${task.id}`)],
    [Markup.button.callback(user?.language === "bn" ? "স্কিপ" : "Skip", `earn:skip:${category}:${task.id}`)],
    [Markup.button.callback(messages.earn.backToCategories, "earn:categories")]
  ];
  if (user) rows.push([Markup.button.callback(messages.common.back, "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function earnSkipKey(userId: number, category: string): string {
  return `${userId}:${category}`;
}

function addEarnSkip(userId: number, category: string, taskId: string) {
  const key = earnSkipKey(userId, category);
  const skipped = earnSkips.get(key) ?? new Set<string>();
  skipped.add(taskId);
  earnSkips.set(key, skipped);
}

function clearEarnSkips(userId: number) {
  for (const key of earnSkips.keys()) {
    if (key.startsWith(`${userId}:`)) earnSkips.delete(key);
  }
}

function formatWithdrawHelp(userId: number, language?: "en" | "bn"): string {
  const messages = getMessages(language);
  const wallet = walletSummary(store.snapshot(), userId);
  return [
    messages.wallet.withdrawRequest,
    `${messages.wallet.withdrawable} ${formatMoney(wallet.withdrawable, language)}`,
    "",
    messages.wallet.format,
    "/withdraw 100 bkash:01XXXXXXXXX"
  ].join("\n");
}

function payoutMethodKeyboard(intent: WithdrawIntent, language?: "en" | "bn", amount?: number) {
  const amountSuffix = amount ? `:${amount}` : "";
  return Markup.inlineKeyboard([
    [Markup.button.callback("UPI (2.9%)", `withdraw:method:upi:${intent}${amountSuffix}`), Markup.button.callback("TRC20 ($1.5)", `withdraw:method:trc20:${intent}${amountSuffix}`)],
    [Markup.button.callback("Binance UID (0 fee)", `withdraw:method:binance_uid:${intent}${amountSuffix}`), Markup.button.callback("bKash (1%)", `withdraw:method:bkash:${intent}${amountSuffix}`)],
    [Markup.button.callback(getMessages(language).common.cancel, "withdraw:cancel")]
  ]);
}

function cancelWithdrawKeyboard(language?: "en" | "bn") {
  return Markup.inlineKeyboard([[Markup.button.callback(getMessages(language).common.cancel, "withdraw:cancel")]]);
}

async function beginWithdraw(ctx: Context, user: { id: number; mode: "freelancer" | "buyer"; language: "en" | "bn"; payoutMethod?: { type: PayoutMethodType; account: string } }, amount: number, intent: WithdrawIntent) {
  const labels = walletLabels(user.language);
  const wallet = walletSummary(store.snapshot(), user.id);
  if (!Number.isFinite(amount) || amount <= 0 || wallet.withdrawable <= 0) {
    const text = `${labels.noWithdrawableBalance}\n${getMessages(user.language).wallet.withdrawable} ${formatMoney(wallet.withdrawable, user.language)}`;
    if (ctx.from) await showFlowScreen(ctx as Context & { from: TelegramFrom }, text, walletKeyboard(user));
    else await showScreen(ctx, text, walletKeyboard(user));
    return;
  }
  if (amount > wallet.withdrawable) {
    const text = `${labels.insufficientBalance}\n${getMessages(user.language).wallet.withdrawable} ${formatMoney(wallet.withdrawable, user.language)}`;
    if (ctx.from) await showFlowScreen(ctx as Context & { from: TelegramFrom }, text, walletKeyboard(user));
    else await showScreen(ctx, text, walletKeyboard(user));
    return;
  }
  if (user.payoutMethod && amount - calculateWithdrawFee(user.payoutMethod.type, amount) <= 0) {
    if (ctx.from) await showFlowScreen(ctx as Context & { from: TelegramFrom }, labels.amountTooLow, walletKeyboard(user));
    else await showScreen(ctx, labels.amountTooLow, walletKeyboard(user));
    return;
  }
  if (!user.payoutMethod) {
    if (ctx.from) await showFlowScreen(ctx as Context & { from: TelegramFrom }, labels.noPayoutSaved, payoutMethodKeyboard(intent, user.language, amount));
    else await showScreen(ctx, labels.noPayoutSaved, payoutMethodKeyboard(intent, user.language, amount));
    return;
  }
  if (ctx.from) await showFlowScreen(ctx as Context & { from: TelegramFrom }, formatWithdrawConfirm(user.payoutMethod.type, user.payoutMethod.account, amount, user.language), withdrawConfirmKeyboard(amount, user.language));
  else await showScreen(ctx, formatWithdrawConfirm(user.payoutMethod.type, user.payoutMethod.account, amount, user.language), withdrawConfirmKeyboard(amount, user.language));
}

function withdrawConfirmKeyboard(amount: number, language?: "en" | "bn") {
  return Markup.inlineKeyboard([
    [Markup.button.callback(walletLabels(language).confirmWithdraw, `withdraw:confirm:${amount}`)],
    [Markup.button.callback(getMessages(language).common.cancel, "withdraw:cancel")]
  ]);
}

function payoutAccountPrompt(method: PayoutMethodType, language?: "en" | "bn"): string {
  if (language === "bn") {
    if (method === "upi") return "আপনার UPI ID পাঠান।";
    if (method === "trc20") return "আপনার TRC20 USDT ওয়ালেট অ্যাড্রেস পাঠান।";
    if (method === "binance_uid") return "আপনার Binance UID পাঠান।";
    return "আপনার bKash নাম্বার পাঠান।";
  }
  if (method === "upi") return "Send your UPI ID.";
  if (method === "trc20") return "Send your TRC20 USDT wallet address.";
  if (method === "binance_uid") return "Send your Binance UID.";
  return "Send your bKash number.";
}

async function handlePayoutAccountMessage(ctx: Context & { from: TelegramFrom; message: unknown }, setup: { method: PayoutMethodType; intent: WithdrawIntent; amount?: number }) {
  const account = extractText(ctx.message);
  const user = await ensureUser(ctx.from);
  await deleteUserInputMessage(ctx);
  if (!account) {
    await showFlowScreen(ctx, payoutAccountPrompt(setup.method, user.language), cancelWithdrawKeyboard(user.language));
    return;
  }

  const updatedUser = {
    ...user,
    payoutMethod: { type: setup.method, account: account.slice(0, 160), updatedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString()
  };
  await store.upsertUser(updatedUser);
  payoutSetupWaiters.delete(user.id);

  if (setup.intent === "custom") {
    customWithdrawWaiters.add(user.id);
    await showFlowScreen(ctx, `${walletLabels(user.language).payoutSaved}: ${formatSavedPayout(setup.method, account)}\n\n${formatCustomWithdrawPrompt(user.id, user.language)}`, cancelWithdrawKeyboard(user.language));
    return;
  }

  if (setup.intent === "all" && setup.amount) {
    await beginWithdraw(ctx, updatedUser, setup.amount, "all");
    return;
  }

  await showFlowScreen(ctx, `${walletLabels(user.language).payoutSaved}: ${formatSavedPayout(setup.method, account)}`, walletKeyboard(updatedUser));
}

async function handleCustomWithdrawAmount(ctx: Context & { from: TelegramFrom; message: unknown }) {
  const user = await ensureUser(ctx.from);
  const text = extractText(ctx.message);
  const amount = Number(text);
  await deleteUserInputMessage(ctx);
  if (!Number.isFinite(amount) || amount <= 0) {
    await showFlowScreen(ctx, walletLabels(user.language).invalidAmount, cancelWithdrawKeyboard(user.language));
    return;
  }
  customWithdrawWaiters.delete(user.id);
  await beginWithdraw(ctx, user, amount, "custom");
}

function formatCustomWithdrawPrompt(userId: number, language?: "en" | "bn"): string {
  const labels = walletLabels(language);
  const messages = getMessages(language);
  const wallet = walletSummary(store.snapshot(), userId);
  return [
    labels.customWithdraw,
    `${messages.wallet.withdrawable} ${formatMoney(wallet.withdrawable, language)}`,
    "",
    labels.sendAmount
  ].join("\n");
}

function formatWithdrawConfirm(method: PayoutMethodType, account: string, amount: number, language?: "en" | "bn"): string {
  const labels = walletLabels(language);
  const fee = calculateWithdrawFee(method, amount);
  const receive = Math.max(amount - fee, 0);
  return [
    labels.withdrawRequest,
    `${labels.amount}: ${formatMoneyDetail(amount, language)}`,
    `${labels.method}: ${payoutMethodLabel(method)}`,
    `${labels.payout}: ${maskPayoutAccount(account)}`,
    `${labels.fee}: ${formatMoneyDetail(fee, language)}`,
    `${labels.receive}: ${formatMoneyDetail(receive, language)}`
  ].join("\n");
}

async function submitSavedWithdrawal(ctx: Context, userId: number, amount: number) {
  const state = store.snapshot();
  const user = state.users.find((item) => item.id === userId);
  const userContext = ctx.from ? (ctx as Context & { from: TelegramFrom }) : undefined;
  const labels = walletLabels(user?.language);
  if (!user?.payoutMethod) {
    if (userContext) await showFlowScreen(userContext, labels.noPayoutSaved, undefined);
    else await ctx.reply(labels.noPayoutSaved);
    return;
  }
  const wallet = walletSummary(state, userId);
  if (!Number.isFinite(amount) || amount <= 0 || wallet.withdrawable < amount) {
    const text = `${labels.insufficientBalance}\n${getMessages(user.language).wallet.withdrawable} ${formatMoney(wallet.withdrawable, user.language)}`;
    if (userContext) await showFlowScreen(userContext, text, walletKeyboard(user));
    else await ctx.reply(text);
    return;
  }
  const fee = calculateWithdrawFee(user.payoutMethod.type, amount);
  if (amount - fee <= 0) {
    if (userContext) await showFlowScreen(userContext, labels.amountTooLow, walletKeyboard(user));
    else await ctx.reply(labels.amountTooLow);
    return;
  }
  const method = `${payoutMethodLabel(user.payoutMethod.type)}:${user.payoutMethod.account} | fee ${roundMoney(fee)} BDT | receive ${roundMoney(amount - fee)} BDT`;
  const withdrawal = createWithdrawal(userId, amount, method);
  await store.addWithdrawal(withdrawal);
  await store.addTransaction(createTransaction({
    userId,
    type: "withdraw_request",
    amount,
    note: method
  }));
  await publishWithdrawalPanel(withdrawal);
  const text = `${labels.withdrawSubmitted}\n\nID: ${withdrawal.id}\n${labels.receive}: ${formatMoneyDetail(amount - fee, user.language)}`;
  if (userContext) await showFlowScreen(userContext, text, walletKeyboard(user));
  else await ctx.reply(text);
}

function formatWithdrawalHistory(userId: number, language?: "en" | "bn"): string {
  const labels = walletLabels(language);
  const withdrawals = store.snapshot().withdrawals.filter((item) => item.userId === userId);
  if (withdrawals.length === 0) return labels.noWithdrawals;
  return [
    labels.withdrawalHistory,
    "",
    ...withdrawals.slice(-8).reverse().map((item) => `- ${item.id}: ${formatMoneyDetail(item.amount, language)}, ${item.status}`)
  ].join("\n");
}

function calculateWithdrawFee(method: PayoutMethodType, amount: number): number {
  if (method === "upi") return amount * 0.029;
  if (method === "bkash") return amount * 0.01;
  if (method === "trc20") return 1.5 * config.usdToBdt;
  return 0;
}

function payoutMethodLabel(method: PayoutMethodType): string {
  if (method === "upi") return "UPI";
  if (method === "trc20") return "TRC20";
  if (method === "binance_uid") return "Binance UID";
  return "bKash";
}

function formatSavedPayout(method: PayoutMethodType, account: string): string {
  return `${payoutMethodLabel(method)} ${maskPayoutAccount(account)} (${payoutFeeLabel(method)})`;
}

function payoutFeeLabel(method: PayoutMethodType): string {
  if (method === "upi") return "2.9% fee";
  if (method === "trc20") return "$1.5 fee";
  if (method === "bkash") return "1% fee";
  return "0 fee";
}

function maskPayoutAccount(account: string): string {
  if (account.length <= 6) return account;
  return `${account.slice(0, 3)}••••${account.slice(-4)}`;
}

function formatUserProfile(userId: number, language?: "en" | "bn"): string {
  const messages = getMessages(language);
  const state = store.snapshot();
  const user = state.users.find((item) => item.id === userId);
  const wallet = walletSummary(state, userId);
  const hold = Math.max(wallet.available - wallet.withdrawable, 0);
  const trust = calculateTrustScore(state, userId);
  const submissions = state.submissions.filter((submission) => submission.workerId === userId);
  const approved = submissions.filter((submission) => submission.status === "approved" || submission.status === "auto_approved").length;
  const rejected = submissions.filter((submission) => submission.status === "rejected").length;
  const activeCampaigns = state.tasks.filter((task) => task.buyerId === userId && ["active", "paused"].includes(task.status)).length;
  const referrals = state.referrals.filter((referral) => referral.referrerId === userId);
  const disputes = state.disputes.filter((dispute) => dispute.workerId === userId);
  const nameLine = `${user?.firstName ?? "Unknown"}${user?.username ? ` (@${user.username})` : ""}`;
  const labels = language === "bn"
    ? { mode: "মোড:", trust: "ট্রাস্ট:", approved: "অ্যাপ্রুভড:", rejected: "রিজেক্টেড:", disputes: "ডিসপিউট:", activeCampaigns: "অ্যাকটিভ ক্যাম্পেইন:", referrals: "রেফারেল:" }
    : { mode: "Mode:", trust: "Trust:", approved: "Approved:", rejected: "Rejected:", disputes: "Disputes:", activeCampaigns: "Active campaigns:", referrals: "Referrals:" };
  const modeLabel = language === "bn"
    ? (user?.mode === "buyer" ? "বায়ার" : "ফ্রিল্যান্সার")
    : (user?.mode ?? "N/A");

  return [
    messages.profile.title,
    nameLine,
    `${labels.mode} ${modeLabel}`,
    `${labels.trust} ${trust.label} ${trust.score}/100`,
    "",
    messages.profile.wallet,
    `${messages.wallet.available} ${formatMoney(wallet.available, language)}`,
    `${messages.wallet.withdrawable} ${formatMoney(wallet.withdrawable, language)}`,
    `${messages.wallet.pending} ${formatMoney(wallet.pending, language)}`,
    `${messages.wallet.autoHold} ${formatMoney(hold, language)}`,
    `${messages.wallet.escrowLocked} ${formatMoney(wallet.escrow, language)}`,
    "",
    messages.profile.activity,
    `${labels.approved} ${approved}`,
    `${labels.rejected} ${rejected}`,
    `${labels.disputes} ${disputes.length}`,
    `${labels.activeCampaigns} ${activeCampaigns}`,
    `${labels.referrals} ${referrals.length}`
  ].join("\n");
}

function languageKeyboard(language?: "en" | "bn") {
  const languageMessages = getMessages(language).language;
  return Markup.inlineKeyboard([
    [Markup.button.callback(languageMessages.english, "language:en")],
    [Markup.button.callback(languageMessages.bangla, "language:bn")]
  ]);
}

function formatLanguageStatus(language: "en" | "bn") {
  const languageMessages = getMessages(language).language;
  const label = language === "bn" ? languageMessages.bangla : languageMessages.english;
  return [
    languageMessages.title,
    `${languageMessages.current} ${label}`,
    "",
    languageMessages.choose
  ].join("\n");
}

function formatUserLookup(userId: number): string {
  const state = store.snapshot();
  const user = state.users.find((item) => item.id === userId);
  const wallet = walletSummary(state, userId);
  const buyerTasks = state.tasks.filter((task) => task.buyerId === userId);
  const submissions = state.submissions.filter((submission) => submission.workerId === userId);
  const approved = submissions.filter((submission) => submission.status === "approved" || submission.status === "auto_approved").length;
  const rejected = submissions.filter((submission) => submission.status === "rejected").length;
  const withdrawals = state.withdrawals.filter((withdrawal) => withdrawal.userId === userId);
  const deposits = state.deposits.filter((deposit) => deposit.userId === userId);
  const referrals = state.referrals.filter((referral) => referral.referrerId === userId);
  const disputes = state.disputes.filter((dispute) => dispute.workerId === userId);
  const calculatedTrust = calculateTrustLevel(state, userId);
  const trust = calculateTrustScore(state, userId);

  return [
    "User Lookup",
    `ID: ${userId}`,
    `Name: ${user?.firstName ?? "Unknown"}`,
    `Username: ${user?.username ? `@${user.username}` : "N/A"}`,
    `Mode: ${user?.mode ?? "N/A"}`,
    `Trust: ${trust.label} ${trust.score}/100 (legacy: ${user?.trustLevel ?? "N/A"}, calculated: ${calculatedTrust})`,
    `Banned: ${user?.isBanned ?? false}`,
    "",
    "Wallet:",
    `Available: ${wallet.available} BDT`,
    `Withdrawable: ${wallet.withdrawable} BDT`,
    `Escrow: ${wallet.escrow} BDT`,
    "",
    `Buyer campaigns: ${buyerTasks.length}`,
    `Worker submissions: ${submissions.length}`,
    `Approved: ${approved}`,
    `Rejected: ${rejected}`,
    `Disputes: ${disputes.length}`,
    `Deposits: ${deposits.length}`,
    `Withdrawals: ${withdrawals.length}`,
    `Referrals: ${referrals.length}`
  ].join("\n");
}

async function setUserBanStatus(userId: number, isBanned: boolean) {
  const user = store.snapshot().users.find((item) => item.id === userId);
  if (!user) throw new Error("User not found.");

  const updatedUser = {
    ...user,
    isBanned,
    updatedAt: new Date().toISOString()
  };
  await store.upsertUser(updatedUser);
  taskDrafts.delete(userId);
  proofWaiters.delete(userId);
  quizWaiters.delete(userId);
  codeWaiters.delete(userId);
  payoutSetupWaiters.delete(userId);
  customWithdrawWaiters.delete(userId);
  supportWaiters.delete(userId);
  geniDrafts.delete(userId);
  return updatedUser;
}

async function refreshUserTrustLevel(userId: number) {
  const state = store.snapshot();
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;

  const trustLevel = calculateTrustLevel(state, userId);
  if (user.trustLevel === trustLevel) return;

  await store.upsertUser({
    ...user,
    trustLevel,
    updatedAt: new Date().toISOString()
  });
}

function getStartPayload(text: string): string | undefined {
  const [, payload] = text.split(" ");
  return payload?.trim();
}

async function maybeApplyReferral(payload: string | undefined, userId: number, wasExistingUser: boolean): Promise<string | undefined> {
  if (!payload?.startsWith("ref_") || wasExistingUser) return undefined;

  const referrerId = Number(payload.replace("ref_", ""));
  if (!Number.isFinite(referrerId) || referrerId === userId) return undefined;

  const state = store.snapshot();
  const referrerExists = state.users.some((user) => user.id === referrerId);
  const alreadyReferred = state.referrals.some((referral) => referral.referredUserId === userId);
  if (!referrerExists || alreadyReferred) return undefined;

  const referral = createReferral({
    referrerId,
    referredUserId: userId,
    bonusAmount: config.referralBonusBdt
  });
  await store.addReferral(referral);

  if (config.referralBonusBdt > 0) {
    await store.addTransaction(createTransaction({
      userId: referrerId,
      type: "earn",
      amount: config.referralBonusBdt,
      note: `Referral bonus for user ${userId}`
    }));
  }

  return "Referral applied.";
}

function formatReferralStats(userId: number, botUsername?: string, language?: "en" | "bn"): string {
  const messages = getMessages(language);
  const referrals = store.snapshot().referrals.filter((referral) => referral.referrerId === userId);
  const credited = referrals.filter((referral) => referral.status === "credited");
  const earned = credited.reduce((sum, referral) => sum + referral.bonusAmount, 0);
  const link = botUsername ? `https://t.me/${botUsername}?start=ref_${userId}` : `https://t.me/YOUR_BOT_USERNAME?start=ref_${userId}`;
  const labels = language === "bn"
    ? { invites: "ইনভাইট:", credited: "ক্রেডিটেড:", earning: "রেফারেল আর্নিং:", inviteLink: "ইনভাইট লিংক:" }
    : { invites: "Invites:", credited: "Credited:", earning: "Referral earning:", inviteLink: "Invite link:" };

  return [
    messages.menu.referrals,
    `${messages.wallet.userId} ${userId}`,
    `${labels.invites} ${referrals.length}`,
    `${labels.credited} ${credited.length}`,
    `${labels.earning} ${formatMoney(earned, language)}`,
    "",
    labels.inviteLink,
    link
  ].join("\n");
}

async function handleSupportMessage(ctx: Context & { from: TelegramFrom; message: unknown }) {
  const user = store.snapshot().users.find((item) => item.id === ctx.from.id);
  const language = user?.language;
  const message = extractText(ctx.message);
  if (!message) {
    await ctx.reply(language === "bn" ? "সাপোর্ট টিকিটের জন্য টেক্সট মেসেজ পাঠান।" : "Send a text message for the support ticket.");
    return;
  }

  const ticket = createSupportTicket(ctx.from.id, message.slice(0, 1500));
  await store.addSupportTicket(ticket);
  supportWaiters.delete(ctx.from.id);
  await ctx.reply(language === "bn" ? `সাপোর্ট টিকিট তৈরি হয়েছে: ${ticket.id}` : `Support ticket created: ${ticket.id}`);
}

function formatOpenTickets(): string {
  const tickets = store.snapshot().supportTickets.filter((ticket) => ticket.status === "open");
  if (tickets.length === 0) return "No open support tickets.";

  return [
    `Open support tickets: ${tickets.length}`,
    "",
    ...tickets.slice(0, 15).map((ticket) => [
      `Ticket: ${ticket.id}`,
      `User: ${ticket.userId}`,
      `Message: ${ticket.message}`,
      `Created: ${ticket.createdAt}`
    ].join("\n"))
  ].join("\n\n");
}

async function closeSupportTicket(ticketId: string) {
  const ticket = store.snapshot().supportTickets.find((item) => item.id === ticketId);
  if (!ticket) throw new Error("Ticket not found.");
  if (ticket.status === "closed") throw new Error("Ticket already closed.");

  const closedTicket = {
    ...ticket,
    status: "closed" as const,
    closedAt: new Date().toISOString()
  };
  await store.updateSupportTicket(closedTicket);
  return closedTicket;
}

async function startTaskWizard(ctx: Context & { from: TelegramFrom }) {
  const messages = userMessages(ctx.from.id);
  setTaskDraft(ctx.from.id, { step: "task_type" });
  await showScreen(ctx, messages.taskWizard.chooseCategory, taskCategoryKeyboard(messages));
}

function taskCategoryKeyboard(messages: MessageBundle = t) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`📢 ${messages.categories.telegram}`, "wizard:category:telegram"), Markup.button.callback(`🌐 ${messages.categories.website}`, "wizard:category:website")],
    [Markup.button.callback(`📱 ${messages.categories.app} (Soon)`, "wizard:coming_soon:app"), Markup.button.callback(`📣 ${messages.categories.social} (Soon)`, "wizard:coming_soon:social")],
    [Markup.button.callback(`📝 ${messages.categories.survey} (Soon)`, "wizard:coming_soon:survey"), Markup.button.callback(`⌨️ ${messages.categories.data_entry} (Soon)`, "wizard:coming_soon:data_entry")],
    [Markup.button.callback(`⭐ ${messages.categories.review} (Soon)`, "wizard:coming_soon:review"), Markup.button.callback(`✅ ${messages.categories.quiz} (Soon)`, "wizard:coming_soon:quiz")],
    [Markup.button.callback(`⚙️ ${messages.categories.custom} (Soon)`, "wizard:coming_soon:custom")],
    [Markup.button.callback(messages.common.cancel, "wizard:cancel")]
  ]);
}

function websiteTimerKeyboard(messages: MessageBundle = t) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("30s", "wizard:website_timer:30"), Markup.button.callback("60s", "wizard:website_timer:60"), Markup.button.callback("120s", "wizard:website_timer:120")],
    [Markup.button.callback("Custom", "wizard:website_timer:custom")],
    [Markup.button.callback(messages.common.cancel, "wizard:cancel")]
  ]);
}

function applyCategoryTemplate(draft: TaskDraft, category: string) {
  if (category === "telegram") {
    draft.title = "Join Telegram channel/group";
    draft.category = "telegram";
    draft.approvalType = "auto";
    draft.verificationType = "telegram_join";
    draft.instructions = "Join the target Telegram channel/group, then verify membership in Neosence.";
    draft.step = "target";
    return;
  }

  draft.title = "Visit website";
  draft.category = "website";
  draft.approvalType = "auto";
  draft.verificationType = "website_visit";
  draft.instructions = "Open the website and stay until the timer ends.";
  draft.step = "target";
}

function parseRewardInput(value: string, language?: "en" | "bn"): number {
  const normalized = value.replace("$", "").trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return Number.NaN;
  return language === "en" ? roundMoney(amount * config.usdToBdt) : amount;
}

function minimumRewardBdt(category?: string): number {
  const minUsd = MIN_REWARD_USD[category ?? ""] ?? MIN_REWARD_USD.website;
  return roundMoney(minUsd * config.usdToBdt);
}

function rewardPrompt(category: string | undefined, language: "en" | "bn" | undefined, messages: MessageBundle = t): string {
  const categoryKey = category ?? "website";
  if (language === "en") {
    const minimum = MIN_REWARD_USD[categoryKey] ?? MIN_REWARD_USD.website;
    return `💰 Reward per worker in USD.\n\nMinimum: $${minimum}\nExample: ${minimum === MIN_REWARD_USD.telegram ? "0.02" : "0.05"}`;
  }
  return [
    messages.taskWizard.enterReward,
    "",
    `Minimum: ${formatMoney(minimumRewardBdt(categoryKey), language)}`
  ].join("\n");
}

function assertActiveTaskCategory(category: string, language?: "en" | "bn") {
  if (ACTIVE_TASK_CATEGORIES.has(category)) return;
  const label = categoryLabel(category, language);
  throw new Error(language === "bn" ? `${label} ক্যাটাগরি শিগগির আসছে।` : `${label} category is coming soon.`);
}

function assertMinimumReward(category: string | undefined, rewardBdt: number, language?: "en" | "bn") {
  const minimum = minimumRewardBdt(category);
  if (rewardBdt >= minimum) return;
  const categoryKey = category ?? "website";
  const minUsd = MIN_REWARD_USD[categoryKey] ?? MIN_REWARD_USD.website;
  throw new Error(language === "en"
    ? `Minimum reward is $${minUsd}.`
    : `মিনিমাম রিওয়ার্ড ${formatMoney(minimum, language)}।`);
}

function applyTaskTypeTemplate(draft: TaskDraft, type: string) {
  if (type === "telegram_join") {
    draft.title = "Join Telegram channel/group";
    draft.category = "telegram";
    draft.approvalType = "auto";
    draft.verificationType = "telegram_join";
    draft.instructions = "Join the target Telegram channel/group, then verify membership in Neosence.";
    draft.step = "target";
    return;
  }

  if (type === "website_visit") {
    draft.title = "Visit website";
    draft.category = "website";
    draft.approvalType = "auto";
    draft.verificationType = "website_visit";
    draft.instructions = "Open the tracking link and keep the verification page open until the timer finishes.";
    draft.step = "target";
    return;
  }

  if (type === "quiz") {
    draft.title = "Complete quiz/code";
    draft.category = "quiz";
    draft.approvalType = "auto";
    draft.verificationType = "quiz";
    draft.instructions = "Submit the correct answer/code in Neosence to complete this task.";
    draft.step = "target";
    return;
  }

  if (type === "app_task") {
    draft.title = "Complete app task";
    draft.category = "app";
    draft.approvalType = "manual";
    draft.instructions = "Complete the app task and submit proof.";
    draft.step = "title";
    return;
  }

  if (type === "manual_proof") {
    draft.category = "manual";
    draft.approvalType = "manual";
    draft.instructions = "Complete the task and submit screenshot, text, link, or document proof.";
    draft.step = "title";
    return;
  }

  draft.category = "custom";
  draft.approvalType = "manual";
  draft.instructions = "Complete the task and submit proof.";
  draft.step = "title";
}

function verificationMethodKeyboard(category: string, messages: MessageBundle = t) {
  const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
  if (category === "telegram") {
    rows.push([Markup.button.callback(messages.verificationMethods.autoJoin, "wizard:method:auto_join")]);
    rows.push([Markup.button.callback(messages.verificationMethods.manualProof, "wizard:method:manual_proof")]);
  } else if (category === "website") {
    rows.push([Markup.button.callback(messages.verificationMethods.manualProof, "wizard:method:manual_proof")]);
    rows.push([Markup.button.callback(messages.verificationMethods.timerVisit, "wizard:method:timer_visit")]);
    rows.push([Markup.button.callback(messages.verificationMethods.webhook, "wizard:method:webhook")]);
  } else if (category === "app") {
    rows.push([Markup.button.callback(messages.verificationMethods.manualProof, "wizard:method:manual_proof")]);
    rows.push([Markup.button.callback(messages.verificationMethods.appTracking, "wizard:method:app_tracking")]);
    rows.push([Markup.button.callback(messages.verificationMethods.inAppCode, "wizard:method:in_app_code")]);
  } else if (category === "quiz") {
    rows.push([Markup.button.callback(messages.verificationMethods.autoAnswer, "wizard:method:quiz_answer")]);
    rows.push([Markup.button.callback(messages.verificationMethods.manualProof, "wizard:method:manual_proof")]);
  } else {
    rows.push([Markup.button.callback(messages.verificationMethods.manualProof, "wizard:method:manual_proof")]);
  }
  rows.push([Markup.button.callback(messages.common.cancel, "wizard:cancel")]);
  return Markup.inlineKeyboard(rows);
}

function applyVerificationMethod(draft: TaskDraft, method: string) {
  if (method === "auto_join") {
    draft.title = "Join Telegram channel/group";
    draft.approvalType = "auto";
    draft.verificationType = "telegram_join";
    draft.instructions = "Join the target Telegram channel/group, then verify membership in Neosence.";
    draft.step = "target";
    return;
  }

  if (method === "timer_visit") {
    draft.title = "Visit website";
    draft.approvalType = "auto";
    draft.verificationType = "website_visit";
    draft.instructions = "Open the tracking link and keep the verification page open until the timer finishes.";
    draft.step = "website_timer";
    return;
  }

  if (method === "quiz_answer") {
    draft.title = "Complete quiz/code";
    draft.approvalType = "auto";
    draft.verificationType = "quiz";
    draft.instructions = "Submit the correct answer/code in Neosence to complete this task.";
    draft.step = "target";
    return;
  }

  if (method === "webhook") {
    draft.title = "Complete website action";
    draft.approvalType = "auto";
    draft.verificationType = "website_webhook";
    draft.instructions = "Complete the required website action. Verification happens through buyer webhook/API.";
    draft.step = "target";
    return;
  }

  if (method === "app_tracking") {
    draft.title = "Complete app task";
    draft.approvalType = "auto";
    draft.verificationType = "app_attribution";
    draft.instructions = "Install/open the app using the tracking flow and complete the required action.";
    draft.step = "target";
    return;
  }

  if (method === "in_app_code") {
    draft.title = "Submit in-app code";
    draft.approvalType = "auto";
    draft.verificationType = "in_app_code";
    draft.instructions = "Find the in-app verification code and submit it in Neosence.";
    draft.step = "target";
    return;
  }

  draft.approvalType = "manual";
  draft.verificationType = undefined;
  draft.verificationTarget = undefined;
  draft.title = defaultTitleForCategory(draft.category ?? "custom");
  draft.instructions = defaultInstructionForCategory(draft.category ?? "custom");
  draft.step = "target";
}

function defaultTitleForCategory(category: string): string {
  return `${categoryLabel(category)} task`;
}

function defaultInstructionForCategory(category: string): string {
  if (category === "social") return "Complete the social action and submit proof.";
  if (category === "survey") return "Complete the survey and submit completion proof.";
  if (category === "data_entry") return "Complete the data entry task and submit proof.";
  if (category === "review") return "Complete the review task and submit proof.";
  if (category === "app") return "Complete the app task and submit proof.";
  if (category === "website") return "Complete the website task and submit proof.";
  if (category === "telegram") return "Complete the Telegram task and submit proof.";
  if (category === "quiz") return "Complete the quiz/code task and submit proof.";
  return "Complete the task and submit proof.";
}

function setTaskDraft(userId: number, draft: Partial<TaskDraft> & { step: TaskDraftStep }) {
  const nowTime = Date.now();
  const existing = taskDrafts.get(userId);
  taskDrafts.set(userId, {
    ...existing,
    ...draft,
    createdAt: existing?.createdAt ?? nowTime,
    updatedAt: nowTime,
    expiresAt: nowTime + DRAFT_TTL_MS
  });
}

function getTaskDraft(userId: number): TaskDraft | undefined {
  const draft = taskDrafts.get(userId);
  if (!draft) return undefined;
  if (Date.now() > draft.expiresAt) {
    taskDrafts.delete(userId);
    return undefined;
  }
  setTaskDraft(userId, draft);
  return taskDrafts.get(userId);
}

async function notifyWaitingDraftsForChat(chat: TrackedChat) {
  if (!chat.canVerifyMembers) return;

  for (const [userId, draft] of taskDrafts.entries()) {
    if (draft.verificationType !== "telegram_join" || draft.verificationTarget !== String(chat.id)) continue;
    if (Date.now() > draft.expiresAt) {
      taskDrafts.delete(userId);
      continue;
    }

    if (chat.canInviteUsers === false) {
      await bot.telegram.sendMessage(
        userId,
        [
          `Bot admin access detected for ${chat.title ?? chat.id}.`,
          "Invite-link permission is still missing. Enable invite users / create invite links permission, then send the same ID again."
        ].join("\n")
      );
      continue;
    }

    draft.step = "confirm";
    taskDrafts.set(userId, draft);
    await bot.telegram.sendMessage(
      userId,
      [
        `Bot admin access detected for ${chat.title ?? chat.id}.`,
        "Telegram join task ready to publish."
      ].join("\n"),
      confirmTaskKeyboard()
    );
  }
}

type TelegramChatMemberLike = {
  status: string;
  is_member?: boolean;
  user?: { id: number; is_bot?: boolean; first_name?: string };
};

type TelegramChatMemberUpdateLike = {
  chat: { id: number; title?: string };
  old_chat_member: TelegramChatMemberLike;
  new_chat_member: TelegramChatMemberLike & { user: { id: number; is_bot?: boolean; first_name?: string } };
  invite_link?: { invite_link?: string };
};

async function handleTelegramMembershipUpdate(ctx: Context) {
  const update = (ctx as unknown as { chatMember?: TelegramChatMemberUpdateLike }).chatMember;
  if (!update?.new_chat_member.user || update.new_chat_member.user.is_bot) return;

  const wasActive = isActiveTelegramMember(update.old_chat_member);
  const isActive = isActiveTelegramMember(update.new_chat_member);

  if (!wasActive && isActive) {
    await handleTelegramMemberJoined(update);
    return;
  }

  if (wasActive && !isActive) {
    await handleTelegramMemberLeft(update);
  }
}

async function handleTelegramMemberJoined(update: TelegramChatMemberUpdateLike) {
  const workerId = update.new_chat_member.user.id;
  const chatId = update.chat.id;
  const inviteUrl = update.invite_link?.invite_link;
  if (!inviteUrl) return;

  const state = store.snapshot();
  const inviteLink = state.telegramInviteLinks.find((link) =>
    link.inviteLink === inviteUrl &&
    link.workerId === workerId &&
    link.chatId === chatId
  );
  if (!inviteLink) return;

  const task = state.tasks.find((item) => item.id === inviteLink.taskId);
  if (!task) return;

  const usedAt = new Date().toISOString();
  const usedInviteLink: TelegramInviteLinkRecord = {
    ...inviteLink,
    status: "used",
    usedAt,
    chatTitle: inviteLink.chatTitle ?? update.chat.title
  };
  await store.upsertTelegramInviteLink(usedInviteLink);

  let submission = store.snapshot().submissions.find((item) => item.taskId === task.id && item.workerId === workerId);
  if (!submission) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId: task.id,
      workerId,
      type: "telegram_join",
      status: "passed",
      metadata: { source: "invite_link", inviteLinkId: inviteLink.id, chatId }
    }));

    try {
      submission = await completeAutoTask(task, workerId, "telegram_join_invite_verified", "Telegram invite join verified");
    } catch (error) {
      await store.addVerificationEvent(createVerificationEvent({
        taskId: task.id,
        workerId,
        type: "telegram_join",
        status: "failed",
        metadata: { source: "invite_link", inviteLinkId: inviteLink.id, chatId, reason: (error as Error).message }
      }));
      return;
    }
  }

  await recordTelegramMembershipForJoin(task, workerId, chatId, inviteLink.id, submission.id);
  await revokeTelegramInviteLink(usedInviteLink);
  await sendTelegramMessageSafe(workerId, `Telegram join verified. ${formatMoneyForUser(workerId, task.rewardPerWorker)} added to your wallet.`);
}

async function handleTelegramMemberLeft(update: TelegramChatMemberUpdateLike) {
  const workerId = update.new_chat_member.user.id;
  const chatId = update.chat.id;
  const activeMemberships = store.snapshot().telegramMemberships.filter((membership) =>
    membership.workerId === workerId &&
    membership.chatId === chatId &&
    membership.active
  );

  for (const membership of activeMemberships) {
    await applyTelegramLeaveClawback(membership);
  }
}

async function recordTelegramMembershipForJoin(
  task: Task,
  workerId: number,
  chatId: number,
  inviteLinkId: string | undefined,
  submissionId: string | undefined
): Promise<TelegramMembershipRecord> {
  const existing = store.snapshot().telegramMemberships.find((membership) =>
    membership.taskId === task.id &&
    membership.workerId === workerId &&
    membership.chatId === chatId
  );
  if (existing && !existing.active) return existing;

  const nowTime = new Date().toISOString();
  const membership: TelegramMembershipRecord = existing
    ? {
      ...existing,
      inviteLinkId: existing.inviteLinkId ?? inviteLinkId,
      submissionId: existing.submissionId ?? submissionId,
      active: true
    }
    : {
      id: localId("tgmem"),
      taskId: task.id,
      workerId,
      buyerId: task.buyerId,
      chatId,
      inviteLinkId,
      submissionId,
      rewardAmount: task.rewardPerWorker,
      recoveredAmount: 0,
      active: true,
      joinedAt: nowTime
    };

  await store.upsertTelegramMembership(membership);
  return membership;
}

async function applyTelegramLeaveClawback(membership: TelegramMembershipRecord) {
  const task = store.snapshot().tasks.find((item) => item.id === membership.taskId);
  const debitAmount = roundMoney(Math.max(membership.rewardAmount - membership.recoveredAmount, 0));
  const nowTime = new Date().toISOString();

  if (!task || debitAmount <= 0) {
    await store.upsertTelegramMembership({ ...membership, active: false, leftAt: nowTime });
    return;
  }

  const workerWallet = walletSummary(store.snapshot(), membership.workerId);
  const recoveredAmount = roundMoney(Math.max(0, Math.min(workerWallet.available, debitAmount)));

  await store.addTransaction(createTransaction({
    userId: membership.workerId,
    type: "clawback_debit",
    amount: debitAmount,
    taskId: membership.taskId,
    submissionId: membership.submissionId,
    note: "Telegram channel/group leave clawback"
  }));

  if (recoveredAmount > 0) {
    await store.addTransaction(createTransaction({
      userId: membership.buyerId,
      type: "clawback_refund",
      amount: recoveredAmount,
      taskId: membership.taskId,
      submissionId: membership.submissionId,
      note: "Recovered Telegram leave refund"
    }));
  }

  await store.upsertTelegramMembership({
    ...membership,
    active: false,
    recoveredAmount: roundMoney(membership.recoveredAmount + recoveredAmount),
    leftAt: nowTime
  });
  await refreshUserTrustLevel(membership.workerId);

  await sendTelegramMessageSafe(
    membership.workerId,
    `You left a Telegram task target. ${formatMoneyForUser(membership.workerId, debitAmount)} was deducted from your balance.`
  );
  if (recoveredAmount > 0) {
    await sendTelegramMessageSafe(
      membership.buyerId,
      `Telegram task leave detected. ${formatMoneyForUser(membership.buyerId, recoveredAmount)} was refunded from recovered worker balance.`
    );
  }
}

async function revokeTelegramInviteLink(link: TelegramInviteLinkRecord) {
  try {
    await bot.telegram.callApi("revokeChatInviteLink", {
      chat_id: link.chatId,
      invite_link: link.inviteLink
    });
    await store.upsertTelegramInviteLink({
      ...link,
      status: "used",
      revokedAt: new Date().toISOString()
    });
  } catch {
    // The link may already be used or expired. Tracking remains valid through the membership record.
  }
}

async function sendTelegramMessageSafe(chatId: number, text: string) {
  try {
    await bot.telegram.sendMessage(chatId, text);
  } catch {
    // User may have blocked the bot; the ledger update is still the source of truth.
  }
}

function isActiveTelegramMember(member: TelegramChatMemberLike): boolean {
  if (["member", "administrator", "creator"].includes(member.status)) return true;
  return member.status === "restricted" && member.is_member === true;
}

function formatMoneyForUser(userId: number, amount: number): string {
  const user = store.snapshot().users.find((item) => item.id === userId);
  return formatMoney(amount, user?.language);
}

async function handleTaskWizardMessage(ctx: Context & { from: TelegramFrom; message: unknown }, draft: TaskDraft) {
  const messages = userMessages(ctx.from.id);
  const text = extractText(ctx.message);
  if (!text) {
    await ctx.reply(messages.common.sendText);
    return;
  }

  if (draft.step === "title") {
    draft.title = text.slice(0, 80);
    if (draft.category && draft.approvalType) {
      draft.step = "instructions";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply(messages.taskWizard.instructionOrTemplate);
      return;
    }

    draft.step = "category";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(messages.taskWizard.enterCategory);
    return;
  }

  if (draft.step === "category") {
    draft.category = text.slice(0, 40).toLowerCase();
    draft.step = "approval";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(messages.taskWizard.chooseApproval, Markup.inlineKeyboard([
      [Markup.button.callback(messages.buttons.manualApproval, "wizard:approval:manual")],
      [Markup.button.callback(messages.buttons.autoVerification, "wizard:approval:auto")],
      [Markup.button.callback(messages.common.cancel, "wizard:cancel")]
    ]));
    return;
  }

  if (draft.step === "reward") {
    const user = store.snapshot().users.find((item) => item.id === ctx.from.id);
    const language = user?.language;
    const reward = parseRewardInput(text, language);
    if (!Number.isFinite(reward) || reward <= 0) {
      await ctx.reply(messages.taskWizard.invalidReward);
      return;
    }
    try {
      assertMinimumReward(draft.category, reward, language);
    } catch (error) {
      await ctx.reply((error as Error).message);
      return;
    }
    draft.rewardPerWorker = reward;
    draft.step = "workers";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(messages.taskWizard.enterWorkers);
    return;
  }

  if (draft.step === "workers") {
    const workerLimit = Number(text);
    if (!Number.isInteger(workerLimit) || workerLimit <= 0) {
      await ctx.reply(messages.taskWizard.invalidWorkers);
      return;
    }
    draft.workerLimit = workerLimit;
    if (draft.instructions) {
      draft.step = "instructions";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply(instructionPrompt(draft, messages), instructionTemplateKeyboard(messages));
      return;
    }

    draft.step = "instructions";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(messages.taskWizard.enterInstruction);
    return;
  }

  if (draft.step === "instructions") {
    if (text.toLowerCase() !== "/skip") {
      draft.instructions = text.slice(0, 1200);
    }

    if (draft.approvalType === "auto" && !draft.verificationType) {
      draft.step = "verification";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply(messages.taskWizard.autoVerificationType, Markup.inlineKeyboard([
        [Markup.button.callback(messages.verificationMethods.telegramJoin, "wizard:verification:telegram_join")],
        [Markup.button.callback(messages.verificationMethods.websiteVisit, "wizard:verification:website_visit")],
        [Markup.button.callback(messages.verificationMethods.websiteWebhook, "wizard:verification:website_webhook")],
        [Markup.button.callback(messages.verificationMethods.appAttribution, "wizard:verification:app_attribution")],
        [Markup.button.callback(messages.verificationMethods.inAppCode, "wizard:verification:in_app_code")],
        [Markup.button.callback(messages.verificationMethods.quiz, "wizard:verification:quiz")],
        [Markup.button.callback(messages.common.cancel, "wizard:cancel")]
      ]));
      return;
    }

    if (!draft.rewardPerWorker) {
      draft.step = "reward";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply(rewardPrompt(draft.category, store.snapshot().users.find((item) => item.id === ctx.from.id)?.language, messages));
      return;
    }

    if (!draft.workerLimit) {
      draft.step = "workers";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply(messages.taskWizard.enterWorkers);
      return;
    }

    draft.step = "confirm";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(formatDraftReview(draft, messages, store.snapshot().users.find((item) => item.id === ctx.from.id)?.language), confirmTaskKeyboard(messages));
    return;
  }

  if (draft.step === "target") {
    if (draft.verificationType === "telegram_join") {
      const chatId = Number(text);
      if (!Number.isFinite(chatId)) {
        await ctx.reply(messages.taskWizard.invalidTelegramChatId);
        return;
      }

      const trackedChat = store.snapshot().trackedChats.find((chat) => chat.id === chatId);
      if (!trackedChat?.canVerifyMembers) {
        draft.verificationTarget = String(chatId);
        taskDrafts.set(ctx.from.id, draft);
        await ctx.reply([
          messages.taskWizard.telegramAdminMissing,
          `Waiting chat ID: ${chatId}`,
        ].join("\n"));
        return;
      }
      if (trackedChat.canInviteUsers === false) {
        draft.verificationTarget = String(chatId);
        taskDrafts.set(ctx.from.id, draft);
        await ctx.reply([
          "Bot admin access is detected, but invite-link permission is missing.",
          "Enable invite users / create invite links permission for this bot, then send the same ID again.",
          `Waiting chat ID: ${chatId}`
        ].join("\n"));
        return;
      }
      draft.verificationTarget = String(chatId);
    } else {
      draft.verificationTarget = text.slice(0, 300);
    }

    if (draft.verificationType === "website_visit" && !draft.websiteVisitSeconds) {
      draft.step = "website_timer";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply(messages.taskWizard.websiteTimerPrompt, websiteTimerKeyboard(messages));
      return;
    }

    await promptNextCommercialStep(ctx, draft);
    return;
  }

  if (draft.step === "website_timer") {
    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) {
      await ctx.reply(messages.taskWizard.invalidWebsiteTimer);
      return;
    }
    draft.websiteVisitSeconds = seconds;
    await promptNextCommercialStep(ctx, draft);
    return;
  }

  await ctx.reply(messages.taskWizard.useButtons);
}

function confirmTaskKeyboard(messages: MessageBundle = t) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(messages.buttons.publishTask, "wizard:confirm")],
    [Markup.button.callback(messages.common.cancel, "wizard:cancel")]
  ]);
}

function instructionTemplateKeyboard(messages: MessageBundle = t) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(messages.buttons.useTemplate, "wizard:instruction:skip")],
    [Markup.button.callback(messages.common.cancel, "wizard:cancel")]
  ]);
}

function instructionPrompt(draft: TaskDraft, messages: MessageBundle = t): string {
  return [
    messages.taskWizard.instructionOrTemplate,
    "",
    messages.taskWizard.templateReadyTitle,
    draft.instructions
  ].filter(Boolean).join("\n");
}

async function promptNextCommercialStep(ctx: Context & { from: TelegramFrom }, draft: TaskDraft) {
  const messages = userMessages(ctx.from.id);
  const user = store.snapshot().users.find((item) => item.id === ctx.from.id);
  if (!draft.rewardPerWorker) {
    draft.step = "reward";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(rewardPrompt(draft.category, user?.language, messages));
    return;
  }

  if (!draft.workerLimit) {
    draft.step = "workers";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(messages.taskWizard.enterWorkers);
    return;
  }

  draft.step = "instructions";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(instructionPrompt(draft, messages), instructionTemplateKeyboard(messages));
}

function formatDraftReview(draft: TaskDraft, messages: MessageBundle = t, language?: "en" | "bn"): string {
  const rewardTotal = (draft.rewardPerWorker ?? 0) * (draft.workerLimit ?? 0);
  const fee = rewardTotal * (config.platformFeePercent / 100);
  return [
    messages.taskWizard.reviewTitle,
    "",
    `Title: ${draft.title}`,
    `Category: ${draft.category}`,
    `Approval: ${draft.approvalType}`,
    `Reward: ${formatMoney(draft.rewardPerWorker ?? 0, language)}`,
    `Workers: ${draft.workerLimit}`,
    `Total escrow: ${formatMoneyDetail(rewardTotal + fee, language)}`,
    draft.verificationType ? `Verification: ${draft.verificationType}` : undefined,
    draft.verificationTarget ? `Target: ${formatDraftTarget(draft)}` : undefined,
    draft.websiteVisitSeconds ? `Visit timer: ${draft.websiteVisitSeconds}s` : undefined,
    "",
    "Instructions:",
    draft.instructions
  ].filter(Boolean).join("\n");
}

function formatDraftTarget(draft: TaskDraft): string {
  if (draft.verificationType === "telegram_join" && draft.verificationTarget) {
    const chatId = Number(draft.verificationTarget);
    const chat = Number.isFinite(chatId)
      ? store.snapshot().trackedChats.find((item) => item.id === chatId)
      : undefined;
    return chat?.title ?? "Telegram channel/group";
  }
  return draft.verificationTarget ?? "";
}

function verificationTargetPrompt(type: VerificationType, messages: MessageBundle = t): string {
  if (type === "telegram_join") return messages.taskWizard.telegramChatIdPrompt;
  if (type === "website_visit") return messages.taskWizard.websiteTargetPrompt;
  if (type === "website_webhook") return messages.taskWizard.webhookTargetPrompt;
  if (type === "app_attribution") return messages.taskWizard.appTargetPrompt;
  if (type === "in_app_code") return messages.taskWizard.inAppCodePrompt;
  return messages.taskWizard.quizAnswerPrompt;
}

function targetPromptForDraft(draft: TaskDraft, messages: MessageBundle = t): string {
  if (draft.verificationType) return verificationTargetPrompt(draft.verificationType, messages);
  if (draft.category === "telegram") return "Send the Telegram channel/group link, username, or chat ID.";
  if (draft.category === "website") return messages.taskWizard.websiteTargetPrompt;
  return messages.taskWizard.websiteTargetPrompt;
}

function isCompleteDraft(draft: TaskDraft): draft is Required<Pick<TaskDraft, "title" | "category" | "approvalType" | "rewardPerWorker" | "workerLimit" | "instructions">> & TaskDraft {
  const baseComplete = Boolean(
    draft.title &&
    draft.category &&
    draft.approvalType &&
    draft.rewardPerWorker &&
    draft.workerLimit &&
    draft.instructions
  );

  if (!baseComplete) return false;
  if (draft.approvalType === "manual") return true;
  if (!draft.verificationType || !draft.verificationTarget) return false;
  if (draft.verificationType === "website_visit") return Boolean(draft.websiteVisitSeconds);
  return true;
}

function extractText(message: unknown): string | undefined {
  const textMessage = message as { text?: string };
  return textMessage.text?.trim();
}

function setGeniDraft(userId: number, draft: Partial<GeniDraft> & { step: GeniDraftStep }) {
  const nowTime = Date.now();
  const existing = geniDrafts.get(userId);
  geniDrafts.set(userId, {
    ...existing,
    ...draft,
    createdAt: existing?.createdAt ?? nowTime,
    updatedAt: nowTime,
    expiresAt: nowTime + DRAFT_TTL_MS
  });
}

async function handleGeniDraftMessage(ctx: Context & { from: TelegramFrom; message: unknown }, draft: GeniDraft) {
  if (Date.now() > draft.expiresAt) {
    geniDrafts.delete(ctx.from.id);
    await showFlowScreen(ctx, "GENI draft expired. Use /geni to start again.", adminBackKeyboard());
    return;
  }

  const text = extractText(ctx.message);
  if (!text) {
    await showFlowScreen(ctx, "Send text only for this GENI step.", geniCancelKeyboard(draft.linkId));
    return;
  }

  if (text.toLowerCase() === "cancel") {
    geniDrafts.delete(ctx.from.id);
    await showFlowScreen(ctx, formatGeniSimpleHome(), geniSimpleKeyboard());
    return;
  }

  if (draft.step === "name") {
    const name = text.slice(0, 80);
    const now = new Date().toISOString();
    const link: GeniLink = {
      id: compactId("gl"),
      name,
      adminId: ctx.from.id,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    await store.upsertGeniLink(link);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "geni_create",
      targetType: "geni_link",
      targetId: link.id,
      note: link.name
    });
    setGeniDraft(ctx.from.id, { step: "shortener", linkId: link.id, name: link.name });
    await showFlowScreen(ctx, [
      "Step 2 of 2",
      "",
      "Copy this Final URL and paste it inside your paid shortener website as Destination URL.",
      "",
      geniFinalUrl(link.id),
      "",
      "After the shortener gives you a short link, paste that short link here.",
      "",
      "Send skip if you want to add it later."
    ].join("\n"), geniCancelKeyboard(link.id));
    return;
  }

  if (draft.step === "shortener") {
    const link = store.snapshot().geniLinks.find((item) => item.id === draft.linkId);
    if (!link) {
      geniDrafts.delete(ctx.from.id);
      await showFlowScreen(ctx, "GENI link not found. Use /geni to start again.", geniSimpleKeyboard());
      return;
    }

    const lower = text.toLowerCase();
    if (lower !== "skip") {
      try {
        assertHttpUrl(text);
      } catch (error) {
        await showFlowScreen(ctx, [
          (error as Error).message,
          "",
          "Send a valid http/https paid shortener URL, or send skip."
        ].join("\n"), geniCancelKeyboard(link.id));
        return;
      }
    }

    const updated: GeniLink = {
      ...link,
      shortenerUrl: lower === "skip" ? link.shortenerUrl : text,
      updatedAt: new Date().toISOString()
    };
    await store.upsertGeniLink(updated);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: lower === "skip" ? "geni_skip_shortener" : "geni_set_shortener",
      targetType: "geni_link",
      targetId: updated.id,
      note: updated.name
    });
    geniDrafts.delete(ctx.from.id);
    await showFlowScreen(ctx, lower === "skip" ? formatGeniLinkNeedsShortener(updated) : formatGeniLinkReady(updated), lower === "skip" ? geniMoreKeyboard(updated) : geniReadyKeyboard(updated));
    return;
  }

  if (draft.step === "profit_cpm") {
    const value = parsePositiveNumber(text, { allowZero: true });
    if (value === undefined) {
      await showFlowScreen(ctx, "Send CPM as a number. Example: 3.5", geniProfitKeyboard());
      return;
    }
    setGeniDraft(ctx.from.id, { ...draft, step: "profit_cost", profitCpmUsd: roundTo(value, 4) });
    await showFlowScreen(ctx, [
      "💹 Profit Check",
      "",
      "Step 2 of 4",
      "Each visitor cost koto?",
      "",
      "Example:",
      "0.001",
      "",
      "If free traffic, send 0."
    ].join("\n"), geniProfitKeyboard());
    return;
  }

  if (draft.step === "profit_cost") {
    const value = parsePositiveNumber(text, { allowZero: true });
    if (value === undefined) {
      await showFlowScreen(ctx, "Send cost per visitor as a number. Example: 0.001", geniProfitKeyboard());
      return;
    }
    setGeniDraft(ctx.from.id, { ...draft, step: "profit_visits", trafficCostPerVisitUsd: roundTo(value, 6) });
    await showFlowScreen(ctx, [
      "💹 Profit Check",
      "",
      "Step 3 of 4",
      "Koto visitor plan korcho?",
      "",
      "Example:",
      "10000"
    ].join("\n"), geniProfitKeyboard());
    return;
  }

  if (draft.step === "profit_visits") {
    const value = parsePositiveNumber(text, { integer: true });
    if (value === undefined) {
      await showFlowScreen(ctx, "Send planned visitors as a whole number. Example: 10000", geniProfitKeyboard());
      return;
    }
    setGeniDraft(ctx.from.id, { ...draft, step: "profit_rate", plannedVisits: value });
    await showFlowScreen(ctx, [
      "💹 Profit Check",
      "",
      "Step 4 of 4",
      "Expected completion rate koto percent?",
      "",
      "Example:",
      "60"
    ].join("\n"), geniProfitKeyboard());
    return;
  }

  if (draft.step === "profit_rate") {
    const value = parsePositiveNumber(text, { allowZero: true, max: 100 });
    if (value === undefined) {
      await showFlowScreen(ctx, "Send completion rate from 0 to 100. Example: 60", geniProfitKeyboard());
      return;
    }

    const settings: GeniSettings = {
      ...geniSettings(),
      profitCpmUsd: draft.profitCpmUsd ?? geniSettings().profitCpmUsd,
      trafficCostPerVisitUsd: draft.trafficCostPerVisitUsd ?? geniSettings().trafficCostPerVisitUsd,
      plannedVisits: draft.plannedVisits ?? geniSettings().plannedVisits,
      expectedCompletionRate: roundTo(value, 2),
      updatedAt: new Date().toISOString()
    };
    await store.updateGeniSettings(settings);
    await addAdminAudit({
      adminId: ctx.from.id,
      action: "geni_profit_settings",
      targetType: "geni",
      note: `CPM ${settings.profitCpmUsd}, cost ${settings.trafficCostPerVisitUsd}, visits ${settings.plannedVisits}, completion ${settings.expectedCompletionRate}%`
    });
    geniDrafts.delete(ctx.from.id);
    await showFlowScreen(ctx, formatGeniProfitCalculator(), geniProfitKeyboard());
  }
}

function assertHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must start with http:// or https://.");
  } catch {
    throw new Error("Invalid URL.");
  }
}

function geniSettings(): GeniSettings {
  return store.snapshot().geniSettings ?? {
    profitCpmUsd: 2,
    trafficCostPerVisitUsd: 0,
    plannedVisits: 1000,
    expectedCompletionRate: 60,
    sameIpLimit: 5,
    sameDeviceLimit: 8,
    blockBotUserAgents: true,
    flagDirectFinalHits: true,
    updatedAt: new Date(0).toISOString()
  };
}

function parseGeniProfitInput(text: string): Pick<GeniSettings, "profitCpmUsd" | "trafficCostPerVisitUsd" | "plannedVisits" | "expectedCompletionRate"> | undefined {
  const parts = text.replace(/,/g, " ").split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 4 || parts.some((item) => !Number.isFinite(item))) return undefined;
  const [profitCpmUsd, trafficCostPerVisitUsd, plannedVisitsRaw, expectedCompletionRate] = parts;
  const plannedVisits = Math.round(plannedVisitsRaw);
  if (profitCpmUsd < 0 || trafficCostPerVisitUsd < 0 || plannedVisits <= 0 || expectedCompletionRate < 0 || expectedCompletionRate > 100) {
    return undefined;
  }
  return {
    profitCpmUsd: roundTo(profitCpmUsd, 4),
    trafficCostPerVisitUsd: roundTo(trafficCostPerVisitUsd, 6),
    plannedVisits,
    expectedCompletionRate: roundTo(expectedCompletionRate, 2)
  };
}

function parsePositiveNumber(text: string, options: { allowZero?: boolean; integer?: boolean; max?: number } = {}): number | undefined {
  const value = Number(text.replace(/[$,%]/g, "").trim());
  if (!Number.isFinite(value)) return undefined;
  if (options.allowZero ? value < 0 : value <= 0) return undefined;
  if (options.max !== undefined && value > options.max) return undefined;
  return options.integer ? Math.round(value) : value;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const digits = abs < 1 ? 4 : 2;
  return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

function geniActualProfit(linkId?: string): number {
  const settings = geniSettings();
  const stats = geniStats(linkId);
  return ((stats.completed / 1000) * settings.profitCpmUsd) - (stats.started * settings.trafficCostPerVisitUsd);
}

function geniSettingsForPreset(preset: "loose" | "normal" | "strict"): GeniSettings {
  const current = geniSettings();
  const values = preset === "loose"
    ? { sameIpLimit: 10, sameDeviceLimit: 15, blockBotUserAgents: true, flagDirectFinalHits: false }
    : preset === "strict"
      ? { sameIpLimit: 2, sameDeviceLimit: 3, blockBotUserAgents: true, flagDirectFinalHits: true }
      : { sameIpLimit: 5, sameDeviceLimit: 8, blockBotUserAgents: true, flagDirectFinalHits: true };
  return {
    ...current,
    ...values,
    updatedAt: new Date().toISOString()
  };
}

function geniSafetyPresetName(settings: GeniSettings): string {
  if (settings.sameIpLimit <= 2 && settings.sameDeviceLimit <= 3 && settings.blockBotUserAgents && settings.flagDirectFinalHits) return "Strict";
  if (settings.sameIpLimit >= 10 && settings.sameDeviceLimit >= 15 && settings.blockBotUserAgents && !settings.flagDirectFinalHits) return "Loose";
  return "Normal";
}

function geniStats(linkId?: string) {
  const visits = linkId
    ? store.snapshot().geniVisits.filter((visit) => visit.linkId === linkId)
    : store.snapshot().geniVisits;
  const started = visits.length;
  const completed = visits.filter((visit) => visit.status === "completed").length;
  const telegramVerified = visits.filter((visit) => visit.telegramUserId).length;
  const suspect = visits.filter((visit) => visit.suspectReason).length;
  const directFinal = visits.filter((visit) => visit.suspectReason === "no_start_session").length;
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const todayStarted = visits.filter((visit) => visit.startedAt.startsWith(todayPrefix)).length;
  const todayCompleted = visits.filter((visit) => visit.completedAt?.startsWith(todayPrefix)).length;
  const completedVisits = visits.filter((visit) => visit.status === "completed");
  return {
    started,
    completed,
    telegramVerified,
    suspect,
    directFinal,
    todayStarted,
    todayCompleted,
    countries: topCounts(completedVisits.map((visit) => visit.country ?? "Unknown")),
    devices: topCounts(completedVisits.map((visit) => visit.deviceType ?? "Unknown")),
    browsers: topCounts(completedVisits.map((visit) => visit.browser ?? "Unknown")),
    completionRate: started > 0 ? Math.round((completed / started) * 100) : 0
  };
}

function topCounts(values: string[], limit = 5): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value || "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function formatTopCounts(items: Array<{ label: string; count: number }>): string {
  if (items.length === 0) return "No data yet.";
  return items.map((item) => `${item.label}: ${item.count}`).join("\n");
}

function formatGeniSimpleHome(): string {
  const stats = geniStats();
  const active = store.snapshot().geniLinks.filter((link) => link.status === "active").length;
  return [
    "🧪 GENI",
    "",
    "What do you want to do?",
    "",
    `Running links: ${active}`,
    `Clicked: ${stats.started}`,
    `Completed: ${stats.completed}`,
    `Profit estimate: ${formatUsd(geniActualProfit())}`,
    "",
    "Use the buttons below."
  ].join("\n");
}

function geniSimpleKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Create Link", "geni:new"), Markup.button.callback("📊 Results", "geni:results")],
    [Markup.button.callback("💹 Profit Check", "geni:profit"), Markup.button.callback("⏸ Stop Link", "geni:stop")],
    [Markup.button.callback("🛡 Safety", "geni:safety"), Markup.button.callback("⚙️ Advanced", "geni:advanced")],
    [Markup.button.callback("⬅️ Admin Panel", "admin:dashboard")]
  ]);
}

function formatGeniAdvancedDashboard(): string {
  const state = store.snapshot();
  const active = state.geniLinks.filter((link) => link.status === "active").length;
  const paused = state.geniLinks.filter((link) => link.status === "paused").length;
  const archived = state.geniLinks.filter((link) => link.status === "archived").length;
  const stats = geniStats();
  return [
    "🧪 GENI Short Link Lab",
    "",
    `Active links: ${active}`,
    `Paused links: ${paused}`,
    `Archived links: ${archived}`,
    "",
    `Today started: ${stats.todayStarted}`,
    `Today completed: ${stats.todayCompleted}`,
    `Completion rate: ${stats.completionRate}%`,
    `Telegram verified: ${stats.telegramVerified}`,
    `Suspect traffic: ${stats.suspect}`,
    "",
    "Experimental admin-only tracking for paid shortener final URLs."
  ].join("\n");
}

function geniAdvancedKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ New Link", "geni:new"), Markup.button.callback("🔗 Links", "geni:links")],
    [Markup.button.callback("📊 Analytics", "geni:analytics"), Markup.button.callback("💹 Profit", "geni:profit")],
    [Markup.button.callback("🛡 Fraud", "geni:fraud"), Markup.button.callback("🧾 Logs", "geni:logs")],
    [Markup.button.callback("⬅️ Simple", "geni:dashboard"), Markup.button.callback("Admin Panel", "admin:dashboard")]
  ]);
}

function geniCancelKeyboard(linkId?: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Cancel", "geni:cancel")],
    linkId ? [Markup.button.callback("Open Link Card", `geni:link:${linkId}`)] : [Markup.button.callback("Dashboard", "geni:dashboard")]
  ]);
}

function formatGeniSimpleResults(): string {
  const stats = geniStats();
  const incomplete = Math.max(0, stats.started - stats.completed);
  const bestCountry = stats.countries[0]?.label ?? "No data";
  const bestDevice = stats.devices[0]?.label ?? "No data";
  return [
    "📊 Results",
    "",
    `Total people clicked: ${stats.started}`,
    `Completed: ${stats.completed}`,
    `Not completed: ${incomplete}`,
    `Telegram verified: ${stats.telegramVerified}`,
    `Suspicious: ${stats.suspect}`,
    "",
    `Best country: ${bestCountry}`,
    `Best device: ${bestDevice}`,
    "",
    `Profit estimate: ${formatUsd(geniActualProfit())}`
  ].join("\n");
}

function geniResultsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔗 Select Link", "geni:links"), Markup.button.callback("💹 Profit", "geni:profit")],
    [Markup.button.callback("🛡 Suspicious", "geni:safety"), Markup.button.callback("⚙️ Details", "geni:advanced")],
    [Markup.button.callback("⬅️ Back", "geni:dashboard")]
  ]);
}

function formatGeniStopList(): string {
  const activeLinks = store.snapshot().geniLinks.filter((link) => link.status === "active");
  if (activeLinks.length === 0) return "⏸ Stop Link\n\nNo running links right now.";
  return [
    "⏸ Stop Link",
    "",
    "Tap the link you want to stop.",
    "",
    ...activeLinks.slice(0, 8).map((link) => {
      const stats = geniStats(link.id);
      return `${link.name}: ${stats.completed}/${stats.started} completed`;
    })
  ].join("\n");
}

function geniStopKeyboard() {
  const rows = store.snapshot().geniLinks
    .filter((link) => link.status === "active")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((link) => [Markup.button.callback(`Stop ${link.name.slice(0, 24)}`, `geni:quick_stop:${link.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", "geni:dashboard")]);
  return Markup.inlineKeyboard(rows);
}

function formatGeniSafety(): string {
  const preset = geniSafetyPresetName(geniSettings());
  return [
    "🛡 Safety",
    "",
    `Strictness: ${preset}`,
    "",
    "Loose: fewer warnings",
    "Normal: balanced",
    "Strict: more fake traffic warnings"
  ].join("\n");
}

function geniSafetyKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Loose", "geni:safety:loose"), Markup.button.callback("Normal", "geni:safety:normal"), Markup.button.callback("Strict", "geni:safety:strict")],
    [Markup.button.callback("⚙️ Advanced Safety", "geni:fraud")],
    [Markup.button.callback("⬅️ Back", "geni:dashboard")]
  ]);
}

function formatGeniLinks(): string {
  const links = store.snapshot().geniLinks
    .filter((link) => link.status !== "archived")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (links.length === 0) return "🔗 GENI Links\n\nNo active links yet.";
  return [
    "🔗 GENI Links",
    "",
    ...links.slice(0, 12).map((link) => {
      const stats = geniStats(link.id);
      return `${geniStatusIcon(link.status)} ${link.name}\n${shortId(link.id)} • ${stats.completed}/${stats.started} completed • ${stats.completionRate}%`;
    })
  ].join("\n\n");
}

function geniLinksKeyboard() {
  const rows = store.snapshot().geniLinks
    .filter((link) => link.status !== "archived")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 10)
    .map((link) => [Markup.button.callback(`${geniStatusIcon(link.status)} ${link.name.slice(0, 28)}`, `geni:link:${link.id}`)]);
  rows.push([Markup.button.callback("➕ New Link", "geni:new")]);
  rows.push([Markup.button.callback("⬅️ Dashboard", "geni:dashboard")]);
  return Markup.inlineKeyboard(rows);
}

function formatGeniAnalytics(): string {
  const stats = geniStats();
  const links = store.snapshot().geniLinks.filter((link) => link.status !== "archived");
  const topLinks = [...links]
    .sort((left, right) => geniStats(right.id).completed - geniStats(left.id).completed)
    .slice(0, 5);
  return [
    "📊 GENI Analytics",
    "",
    `Started: ${stats.started}`,
    `Completed: ${stats.completed}`,
    `Completion rate: ${stats.completionRate}%`,
    `Telegram verified: ${stats.telegramVerified}`,
    `Direct final hits: ${stats.directFinal}`,
    `Suspect: ${stats.suspect}`,
    "",
    "Top countries:",
    formatTopCounts(stats.countries),
    "",
    "Top devices:",
    formatTopCounts(stats.devices),
    "",
    "Top browsers:",
    formatTopCounts(stats.browsers),
    "",
    "Top links:",
    ...(topLinks.length > 0 ? topLinks.map((link) => {
      const itemStats = geniStats(link.id);
      return `${link.name}: ${itemStats.completed}/${itemStats.started} (${itemStats.completionRate}%)`;
    }) : ["No data yet."])
  ].join("\n");
}

function formatGeniProfitCalculator(): string {
  const settings = geniSettings();
  const actual = geniStats();
  const projectedCompleted = Math.round(settings.plannedVisits * (settings.expectedCompletionRate / 100));
  const projectedIncome = (projectedCompleted / 1000) * settings.profitCpmUsd;
  const projectedCost = settings.plannedVisits * settings.trafficCostPerVisitUsd;
  const projectedProfit = projectedIncome - projectedCost;
  const actualIncome = (actual.completed / 1000) * settings.profitCpmUsd;
  const actualCost = actual.started * settings.trafficCostPerVisitUsd;
  const actualProfit = actualIncome - actualCost;
  const breakEvenCost = (settings.profitCpmUsd * (settings.expectedCompletionRate / 100)) / 1000;
  const result = projectedProfit > 0 ? "Looks profitable" : projectedProfit < 0 ? "May lose money" : "Break-even";

  return [
    "💹 Profit Check",
    "",
    `You may earn: ${formatUsd(projectedIncome)}`,
    `Your cost: ${formatUsd(projectedCost)}`,
    `Profit: ${formatUsd(projectedProfit)}`,
    `Result: ${result}`,
    "",
    "Your numbers:",
    `CPM: ${formatUsd(settings.profitCpmUsd)}`,
    `Visitor cost: ${formatUsd(settings.trafficCostPerVisitUsd)}`,
    `Visitors: ${settings.plannedVisits}`,
    `Completion: ${settings.expectedCompletionRate}%`,
    `Expected completed: ${projectedCompleted}`,
    "",
    "Current GENI estimate:",
    `Started: ${actual.started}`,
    `Completed: ${actual.completed}`,
    `Income: ${formatUsd(actualIncome)}`,
    `Cost: ${formatUsd(actualCost)}`,
    `Profit: ${formatUsd(actualProfit)}`,
    "",
    `Break-even visitor cost: ${formatUsd(breakEvenCost)}`
  ].join("\n");
}

function geniProfitKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Change Numbers", "geni:profit:edit")],
    [Markup.button.callback("📊 Results", "geni:results"), Markup.button.callback("⬅️ Back", "geni:dashboard")]
  ]);
}

function formatGeniFraudSettings(): string {
  const settings = geniSettings();
  return [
    "🛡 GENI Fraud Tuning",
    "",
    `Same IP limit: ${settings.sameIpLimit}`,
    `Same device limit: ${settings.sameDeviceLimit}`,
    `Block bot user-agents: ${settings.blockBotUserAgents ? "on" : "off"}`,
    `Flag direct final hits: ${settings.flagDirectFinalHits ? "on" : "off"}`,
    "",
    "Current traffic flags use these limits instantly for new visits."
  ].join("\n");
}

function geniFraudKeyboard() {
  const settings = geniSettings();
  return Markup.inlineKeyboard([
    [Markup.button.callback("IP -", "geni:fraud:ip:down"), Markup.button.callback(`IP ${settings.sameIpLimit}`, "noop"), Markup.button.callback("IP +", "geni:fraud:ip:up")],
    [Markup.button.callback("Device -", "geni:fraud:device:down"), Markup.button.callback(`Device ${settings.sameDeviceLimit}`, "noop"), Markup.button.callback("Device +", "geni:fraud:device:up")],
    [Markup.button.callback(`Bot UA: ${settings.blockBotUserAgents ? "on" : "off"}`, "geni:fraud:bot:toggle")],
    [Markup.button.callback(`Direct final: ${settings.flagDirectFinalHits ? "flag" : "allow"}`, "geni:fraud:direct:toggle")],
    [Markup.button.callback("🧪 Dashboard", "geni:dashboard")]
  ]);
}

function formatGeniLogs(): string {
  const state = store.snapshot();
  const links = new Map(state.geniLinks.map((link) => [link.id, link]));
  const visits = [...state.geniVisits].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12);
  if (visits.length === 0) return "🧾 GENI Logs\n\nNo visits yet.";
  return [
    "🧾 GENI Logs",
    "",
    ...visits.map((visit) => [
      `${visit.status.toUpperCase()} • ${links.get(visit.linkId)?.name ?? visit.linkId}`,
      `Visit: ${shortId(visit.id)}`,
      visit.telegramUserId ? `Telegram: ${visit.telegramUserId}` : undefined,
      `Country/device: ${visit.country ?? "Unknown"} / ${visit.deviceType ?? "Unknown"}`,
      visit.suspectReason ? `Flag: ${visit.suspectReason}` : undefined,
      `Time: ${formatDateTime(visit.updatedAt)}`
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

function formatGeniLinkDetail(link: GeniLink): string {
  const stats = geniStats(link.id);
  return [
    "🧪 Link",
    "",
    `Name: ${link.name}`,
    `Status: ${link.status === "active" ? "Running" : link.status}`,
    "",
    `Clicked: ${stats.started}`,
    `Completed: ${stats.completed}`,
    `Not completed: ${Math.max(0, stats.started - stats.completed)}`,
    `Telegram verified: ${stats.telegramVerified}`,
    `Suspect: ${stats.suspect}`,
    "",
    `Profit estimate: ${formatUsd(geniActualProfit(link.id))}`,
    "",
    "Share this Tracking Link:",
    geniStartUrl(link.id)
  ].join("\n");
}

function formatGeniLinkReady(link: GeniLink): string {
  return [
    "✅ Done",
    "",
    "Now share this Tracking Link:",
    geniStartUrl(link.id),
    "",
    "Only share this link.",
    "",
    "Bot will count who clicked and who completed."
  ].join("\n");
}

function formatGeniLinkNeedsShortener(link: GeniLink): string {
  return [
    "🔗 Link saved",
    "",
    "Shortener URL is not added yet.",
    "",
    "Before sharing, open More and add the shortener URL.",
    "",
    "Final URL for your shortener:",
    geniFinalUrl(link.id)
  ].join("\n");
}

function formatGeniLinkUrls(link: GeniLink): string {
  return [
    "🔗 GENI URLs",
    "",
    `Name: ${link.name}`,
    "",
    "Start URL:",
    geniStartUrl(link.id),
    "",
    "Final URL:",
    geniFinalUrl(link.id),
    "",
    "How to use:",
    "1. Use Final URL as the paid shortener destination.",
    "2. Paste the paid shortener URL back into this link card.",
    "3. Share Start URL to track start + completion."
  ].join("\n");
}

function geniLinkKeyboard(link: GeniLink) {
  const statusButton = link.status === "active"
    ? Markup.button.callback("⏸ Stop", `geni:pause:${link.id}`)
    : Markup.button.callback("▶️ Start", `geni:resume:${link.id}`);
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Result", `geni:link:${link.id}`), Markup.button.callback("💹 Profit", "geni:profit")],
    [statusButton, Markup.button.callback("🔧 More", `geni:urls:${link.id}`)],
    [Markup.button.callback("🔗 Links", "geni:links"), Markup.button.callback("⬅️ Home", "geni:dashboard")]
  ]);
}

function geniReadyKeyboard(link: GeniLink) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Result", `geni:link:${link.id}`), Markup.button.callback("🔗 All Links", "geni:links")],
    [Markup.button.callback("⬅️ Home", "geni:dashboard")]
  ]);
}

function geniMoreKeyboard(link: GeniLink) {
  const statusButton = link.status === "active"
    ? Markup.button.callback("⏸ Stop", `geni:pause:${link.id}`)
    : Markup.button.callback("▶️ Start", `geni:resume:${link.id}`);
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ Shortener", `geni:shortener:${link.id}`), statusButton],
    [Markup.button.callback("🗑 Archive", `geni:archive:${link.id}`)],
    [Markup.button.callback("📊 Result", `geni:link:${link.id}`), Markup.button.callback("⬅️ Home", "geni:dashboard")]
  ]);
}

function geniStatusIcon(status: GeniLink["status"]): string {
  if (status === "active") return "🟢";
  if (status === "paused") return "⏸";
  return "⚫";
}

function geniStartUrl(linkId: string): string {
  return new URL(`/geni/go/${encodeURIComponent(linkId)}`, publicBaseUrl()).toString();
}

function geniFinalUrl(linkId: string): string {
  return new URL(`/geni/done/${encodeURIComponent(linkId)}`, publicBaseUrl()).toString();
}

function adminRoleIcon(role: AdminRole): string {
  if (role === "owner") return "👑";
  if (role === "manager") return "🧭";
  if (role === "finance") return "🏦";
  if (role === "reviewer") return "✅";
  return "🎧";
}

function adminRoleRank(role: AdminRole): number {
  if (role === "owner") return 1;
  if (role === "manager") return 2;
  if (role === "finance") return 3;
  if (role === "reviewer") return 4;
  return 5;
}

function activeAdminViews(): Array<{ userId: number; role: AdminRole; source: "env" | "panel"; updatedAt?: string }> {
  const views = new Map<number, { userId: number; role: AdminRole; source: "env" | "panel"; updatedAt?: string }>();
  for (const userId of config.adminIds) {
    views.set(userId, { userId, role: "owner", source: "env" });
  }

  for (const member of store.snapshot().adminMembers.filter((item) => item.active)) {
    if (views.has(member.userId)) continue;
    views.set(member.userId, {
      userId: member.userId,
      role: member.role,
      source: "panel",
      updatedAt: member.updatedAt
    });
  }

  return [...views.values()].sort((left, right) => adminRoleRank(left.role) - adminRoleRank(right.role) || left.userId - right.userId);
}

function formatAdminMemberLine(member: { userId: number; role: AdminRole; source: "env" | "panel"; updatedAt?: string }): string {
  const source = member.source === "env" ? "env owner" : "panel";
  const updated = member.updatedAt ? ` • ${formatDateTime(member.updatedAt)}` : "";
  return `${adminRoleIcon(member.role)} ${member.userId} • ${adminRoleLabel(member.role)} • ${source}${updated}`;
}

function adminDashboardCounts() {
  const state = store.snapshot();
  return {
    users: state.users.length,
    tasks: state.tasks.length,
    activeTasks: state.tasks.filter((item) => item.status === "active").length,
    pendingWithdrawals: state.withdrawals.filter((item) => item.status === "pending").length,
    pendingDeposits: state.deposits.filter((item) => item.status === "pending").length,
    pendingSubmissions: state.submissions.filter((item) => item.status === "pending").length,
    openDisputes: state.disputes.filter((item) => item.status === "open").length,
    openTickets: state.supportTickets.filter((item) => item.status === "open").length,
    activeAdmins: activeAdminViews().length
  };
}

function formatAdminDashboard(): string {
  const counts = adminDashboardCounts();
  return [
    "🛠️ Neosence Admin Panel",
    "",
    "📊 Live Summary",
    `Users: ${counts.users}`,
    `Tasks: ${counts.tasks} (${counts.activeTasks} active)`,
    "",
    "⏳ Pending",
    `Withdrawals: ${counts.pendingWithdrawals}`,
    `Deposits: ${counts.pendingDeposits}`,
    `Manual proofs: ${counts.pendingSubmissions}`,
    `Disputes: ${counts.openDisputes}`,
    `Tickets: ${counts.openTickets}`,
    `Admins: ${counts.activeAdmins}`,
    "",
    "Choose an area below, or use /help for commands."
  ].join("\n");
}

function adminDashboardKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⏳ Pending", "admin:pending"), Markup.button.callback("📊 Stats", "admin:stats")],
    [Markup.button.callback("🏦 Withdrawals", "admin:withdrawals"), Markup.button.callback("💰 Deposits", "admin:deposits")],
    [Markup.button.callback("📌 Submissions", "admin:submissions"), Markup.button.callback("⚖️ Disputes", "admin:disputes")],
    [Markup.button.callback("🎧 Tickets", "admin:tickets"), Markup.button.callback("👤 Users", "admin:users")],
    [Markup.button.callback("👮 Admins", "admin:admins"), Markup.button.callback("⚙️ Settings", "admin:settings")],
    [Markup.button.callback("❔ Help", "admin:help")],
    [Markup.button.callback("🔄 Refresh Panel", "admin:refresh")]
  ]);
}

function adminBackKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]]);
}

function adminStatsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh Panel", "admin:refresh")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminPendingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🏦 Withdrawals", "admin:withdrawals"), Markup.button.callback("💰 Deposits", "admin:deposits")],
    [Markup.button.callback("📌 Manual Proofs", "admin:submissions"), Markup.button.callback("⚖️ Disputes", "admin:disputes")],
    [Markup.button.callback("🎧 Tickets", "admin:tickets")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminHelpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👮 Admins", "admin:admins"), Markup.button.callback("⚙️ Settings", "admin:settings")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminSettingsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👮 Admins", "admin:admins"), Markup.button.callback("🧾 Audit", "admin:audit")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminAuditKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚙️ Settings", "admin:settings"), Markup.button.callback("👮 Admins", "admin:admins")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminUsersKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👮 Admins", "admin:admins")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminTicketsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👤 User Lookup", "admin:users")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function formatAdminStats(): string {
  const state = store.snapshot();
  const walletVolume = state.walletTransactions
    .filter((item) => item.status === "completed")
    .reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const completedSubmissions = state.submissions.filter((item) => item.status === "approved" || item.status === "auto_approved").length;
  const rejectedSubmissions = state.submissions.filter((item) => item.status === "rejected").length;

  return [
    "📊 Platform Stats",
    "",
    `Users: ${state.users.length}`,
    `Tasks: ${state.tasks.length}`,
    `Active tasks: ${state.tasks.filter((item) => item.status === "active").length}`,
    `Submissions: ${state.submissions.length}`,
    `Approved/auto: ${completedSubmissions}`,
    `Rejected: ${rejectedSubmissions}`,
    `Wallet transactions: ${state.walletTransactions.length}`,
    `Completed volume: ${formatMoneyDetail(walletVolume, "en")}`
  ].join("\n");
}

function formatAdminPending(): string {
  const counts = adminDashboardCounts();
  return [
    "⏳ Pending Review",
    "",
    `🏦 Withdrawals: ${counts.pendingWithdrawals}`,
    `💰 Deposits: ${counts.pendingDeposits}`,
    `📌 Manual proofs: ${counts.pendingSubmissions}`,
    `⚖️ Disputes: ${counts.openDisputes}`,
    `🎧 Tickets: ${counts.openTickets}`,
    "",
    "Use the buttons below to open each queue."
  ].join("\n");
}

function formatAdminWithdrawalList(): string {
  const withdrawals = store.snapshot().withdrawals.filter((item) => item.status === "pending");
  if (withdrawals.length === 0) return "🏦 Withdrawals\n\nNo pending withdrawals.";

  return [
    `🏦 Pending Withdrawals (${withdrawals.length})`,
    "",
    ...withdrawals.slice(0, 10).map((withdrawal) => [
      `${shortId(withdrawal.id)} • ${formatMoneyDetail(withdrawal.amount, "en")}`,
      `User: ${withdrawal.userId}`,
      `Method: ${withdrawal.method}`
    ].join("\n"))
  ].join("\n\n");
}

function adminWithdrawalListKeyboard() {
  const withdrawals = store.snapshot().withdrawals.filter((item) => item.status === "pending").slice(0, 10);
  const rows = withdrawals.map((withdrawal) => [
    Markup.button.callback(`🏦 ${shortId(withdrawal.id)} • ${formatMoney(withdrawal.amount, "en")}`, `admin:withdraw:view:${withdrawal.id}`)
  ]);
  rows.push([Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]);
  return Markup.inlineKeyboard(rows);
}

function formatAdminDepositList(): string {
  const deposits = store.snapshot().deposits.filter((item) => item.status === "pending");
  if (deposits.length === 0) return "💰 Deposits\n\nNo pending deposits.";

  return [
    `💰 Pending Deposits (${deposits.length})`,
    "",
    ...deposits.slice(0, 10).map((deposit) => [
      `${shortId(deposit.id)} • ${formatMoneyDetail(deposit.amount, "en")}`,
      `User: ${deposit.userId}`,
      `Method: ${deposit.method}`,
      deposit.proof ? `Proof: ${deposit.proof}` : undefined
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

function adminDepositListKeyboard() {
  const deposits = store.snapshot().deposits.filter((item) => item.status === "pending").slice(0, 8);
  const rows = deposits.map((deposit) => [
    Markup.button.callback(`✅ ${shortId(deposit.id)}`, `deposit:approve:${deposit.id}`),
    Markup.button.callback(`❌ ${shortId(deposit.id)}`, `deposit:reject:${deposit.id}`)
  ]);
  rows.push([Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]);
  return Markup.inlineKeyboard(rows);
}

function formatPendingSubmissions(submissions: Submission[]): string {
  if (submissions.length === 0) return "📌 Manual Proofs\n\nNo pending manual submissions.";

  return [
    `📌 Pending Manual Proofs (${submissions.length})`,
    "",
    ...submissions.slice(0, 10).map((submission) => [
      `${shortId(submission.id)} • ${formatMoneyDetail(submission.rewardAmount, "en")}`,
      `Task: ${submission.taskId}`,
      `Worker: ${submission.workerId}`
    ].join("\n"))
  ].join("\n\n");
}

function formatAdminSettings(): string {
  const activeAdmins = activeAdminViews();
  const inactivePanelAdmins = store.snapshot().adminMembers.filter((item) => !item.active).length;
  return [
    "⚙️ System Settings",
    "",
    `Panel channel: ${config.adminPanelChannelId ? config.adminPanelChannelId : "not configured"}`,
    `Console group: ${config.adminConsoleGroupId ? config.adminConsoleGroupId : "not configured"}`,
    `Active admins: ${activeAdmins.length}`,
    `Inactive panel admins: ${inactivePanelAdmins}`,
    `Platform fee: ${config.platformFeePercent}%`,
    `Withdraw hold: ${config.autoWithdrawHoldHours}h`,
    `USD rate: 1 USD = ${config.usdToBdt} BDT`,
    `Storage: ${config.databaseUrl ? "PostgreSQL" : "local JSON"}`
  ].join("\n");
}

function formatAdminAudit(): string {
  const state = store.snapshot();
  const recentEvents = state.adminAuditEvents.slice(-12).reverse();
  const recentLedger = state.walletTransactions.slice(-5).reverse();
  if (recentEvents.length === 0 && recentLedger.length === 0) return "🧾 Audit\n\nNo activity yet.";

  return [
    "🧾 Admin Audit",
    "",
    recentEvents.length > 0 ? "Recent admin actions:" : undefined,
    ...recentEvents.map((event) => [
      `${event.action} • admin ${event.adminId}`,
      event.targetType && event.targetId ? `Target: ${event.targetType} ${event.targetId}` : undefined,
      event.note ? `Note: ${event.note}` : undefined,
      `Time: ${formatDateTime(event.createdAt)}`
    ].filter(Boolean).join("\n")),
    recentLedger.length > 0 ? "" : undefined,
    recentLedger.length > 0 ? "Recent ledger:" : undefined,
    ...recentLedger.map((item) => [
      `${item.type} • ${formatMoneyDetail(item.amount, "en")}`,
      `User: ${item.userId}`,
      item.taskId ? `Task: ${item.taskId}` : undefined,
      item.note ? `Note: ${item.note}` : undefined
    ].filter(Boolean).join("\n"))
  ].filter((line) => line !== undefined).join("\n\n");
}

function formatAdminHelp(): string {
  return [
    "❔ Admin Command Guide",
    "",
    ...ADMIN_CONSOLE_COMMANDS.map((item) => `/${item.command} - ${item.description}`)
  ].join("\n");
}

function formatAdminManagement(): string {
  const admins = activeAdminViews();
  const state = store.snapshot();
  const panelActive = state.adminMembers.filter((item) => item.active).length;
  const panelInactive = state.adminMembers.filter((item) => !item.active).length;

  return [
    "👮 Admin Team",
    "",
    `Active admins: ${admins.length}`,
    `Panel admins: ${panelActive}`,
    `Inactive records: ${panelInactive}`,
    "",
    "Top admins:",
    ...(admins.length > 0 ? admins.slice(0, 8).map(formatAdminMemberLine) : ["No admins configured."]),
    "",
    "Commands:",
    "/addadmin <userId> <role>",
    "/role <userId> <role>",
    "/removeadmin <userId>"
  ].join("\n");
}

function formatAdminList(): string {
  const admins = activeAdminViews();
  const inactive = store.snapshot().adminMembers.filter((item) => !item.active);
  return [
    "👮 Admin List",
    "",
    ...(admins.length > 0 ? admins.map(formatAdminMemberLine) : ["No active admins."]),
    "",
    `Inactive panel records: ${inactive.length}`
  ].join("\n");
}

function formatAdminRoles(): string {
  return [
    "🔐 Admin Roles",
    "",
    "👑 Owner: full access, admin team, settings",
    "🧭 Manager: queues, finance, users, moderation, support",
    "🏦 Finance: withdrawals, deposits, user lookup",
    "✅ Reviewer: manual proofs, disputes, user lookup",
    "🎧 Support: tickets and user lookup",
    "",
    "Only Owner can add, remove, or change admins."
  ].join("\n");
}

function adminManagementKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👮 List", "admin:admins:list"), Markup.button.callback("🔐 Roles", "admin:admins:roles")],
    [Markup.button.callback("➕ Add Help", "admin:admins:add_help"), Markup.button.callback("🧾 Audit", "admin:audit")],
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function adminReviewKeyboard(deposits: DepositRequest[], disputes: Dispute[], submissions: Submission[], withdrawals: Withdrawal[]) {
  const rows = [
    ...deposits.slice(0, 5).map((deposit) => [
      Markup.button.callback(`Approve dep ${shortId(deposit.id)} - ${deposit.amount} BDT`, `deposit:approve:${deposit.id}`),
      Markup.button.callback(`Reject dep ${shortId(deposit.id)}`, `deposit:reject:${deposit.id}`)
    ]),
    ...disputes.slice(0, 5).map((dispute) => [
      Markup.button.callback(`Pay dispute ${shortId(dispute.id)}`, `dispute:pay:${dispute.id}`),
      Markup.button.callback(`Uphold ${shortId(dispute.id)}`, `dispute:uphold:${dispute.id}`)
    ]),
    ...submissions.slice(0, 5).map((submission) => [
      Markup.button.callback(`Review ${shortId(submission.id)}`, `submission:view:${submission.id}`)
    ]),
    ...withdrawals.slice(0, 5).map((withdrawal) => [
      Markup.button.callback(`Pay ${shortId(withdrawal.id)} - ${withdrawal.amount} BDT`, `admin:withdraw:pay:${withdrawal.id}`),
      Markup.button.callback(`Reject ${shortId(withdrawal.id)}`, `admin:withdraw:reject_menu:${withdrawal.id}`)
    ])
  ];

  if (rows.length === 0) {
    return Markup.inlineKeyboard([[Markup.button.callback("No pending review", "noop")]]);
  }

  return Markup.inlineKeyboard(rows);
}

function adminPanelTargets(): Array<{ chatId: number; surface: AdminPanelMessage["surface"] }> {
  return [
    config.adminPanelChannelId ? { chatId: config.adminPanelChannelId, surface: "channel" as const } : undefined,
    config.adminConsoleGroupId ? { chatId: config.adminConsoleGroupId, surface: "group" as const } : undefined
  ].filter((item): item is { chatId: number; surface: AdminPanelMessage["surface"] } => Boolean(item));
}

async function publishWithdrawalPanel(withdrawal: Withdrawal) {
  for (const target of adminPanelTargets()) {
    const existing = store.snapshot().adminPanelMessages.find((message) =>
      message.entityType === "withdrawal" &&
      message.entityId === withdrawal.id &&
      message.surface === target.surface
    );
    if (existing) continue;

    try {
      const sent = await bot.telegram.sendMessage(
        target.chatId,
        formatWithdrawalPanelCard(withdrawal, target.surface),
        taskHtmlExtra(adminWithdrawalKeyboard(withdrawal))
      );
      await store.upsertAdminPanelMessage({
        id: localId("apm"),
        entityType: "withdrawal",
        entityId: withdrawal.id,
        chatId: target.chatId,
        messageId: sent.message_id,
        surface: target.surface,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn("Failed to publish withdrawal panel message", target, error instanceof Error ? error.message : error);
    }
  }
}

async function syncWithdrawalPanelMessages(withdrawalId: string) {
  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) return;

  if (withdrawal.status === "pending") {
    await publishWithdrawalPanel(withdrawal);
  }

  const messages = store.snapshot().adminPanelMessages.filter((message) =>
    message.entityType === "withdrawal" &&
    message.entityId === withdrawal.id
  );

  for (const message of messages) {
    await editWithdrawalPanelMessage(message, withdrawal);
  }
}

async function refreshAdminPanelMessages(): Promise<number> {
  const pendingWithdrawals = store.snapshot().withdrawals.filter((withdrawal) => withdrawal.status === "pending");
  for (const withdrawal of pendingWithdrawals) {
    await syncWithdrawalPanelMessages(withdrawal.id);
  }
  return pendingWithdrawals.length;
}

async function editWithdrawalPanelMessage(message: AdminPanelMessage, withdrawal: Withdrawal) {
  try {
    await bot.telegram.editMessageText(
      message.chatId,
      message.messageId,
      undefined,
      formatWithdrawalPanelCard(withdrawal, message.surface),
      taskHtmlExtra(adminWithdrawalKeyboard(withdrawal)) as Parameters<typeof bot.telegram.editMessageText>[4]
    );
    await store.upsertAdminPanelMessage({ ...message, updatedAt: new Date().toISOString() });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("message is not modified")) return;

    try {
      const replacement = await bot.telegram.sendMessage(
        message.chatId,
        formatWithdrawalPanelCard(withdrawal, message.surface),
        taskHtmlExtra(adminWithdrawalKeyboard(withdrawal))
      );
      await store.upsertAdminPanelMessage({
        ...message,
        messageId: replacement.message_id,
        updatedAt: new Date().toISOString()
      });
    } catch (sendError) {
      console.warn("Failed to sync withdrawal panel message", message, sendError instanceof Error ? sendError.message : sendError);
    }
  }
}

function formatWithdrawalPanelCard(withdrawal: Withdrawal, surface: AdminPanelMessage["surface"]): string {
  const state = store.snapshot();
  const user = state.users.find((item) => item.id === withdrawal.userId);
  const trust = calculateTrustScore(state, withdrawal.userId);
  const commandHint = surface === "group" && withdrawal.status === "pending"
    ? [
      "",
      "<b>Console</b>",
      `<code>/paywd ${escapeHtml(withdrawal.id)}</code>`,
      `<code>/rejectwd ${escapeHtml(withdrawal.id)} reason</code>`
    ]
    : [];

  return [
    "🏦 <b>Withdrawal Request</b>",
    "",
    `<b>ID:</b> <code>${escapeHtml(withdrawal.id)}</code>`,
    `<b>User:</b> ${escapeHtml(formatAdminUser(user, withdrawal.userId))}`,
    `<b>Amount:</b> ${escapeHtml(formatMoneyDetail(withdrawal.amount, "en"))}`,
    `<b>Method:</b> ${escapeHtml(withdrawal.method)}`,
    `<b>Trust:</b> ${escapeHtml(`${trust.badge} ${trust.level} ${trust.score}/100`)}`,
    `<b>Status:</b> ${formatWithdrawalPanelStatus(withdrawal)}`,
    withdrawal.reviewedAt ? `<b>Reviewed:</b> ${escapeHtml(formatDateTime(withdrawal.reviewedAt))}` : undefined,
    withdrawal.rejectReason ? `<b>Reason:</b> ${escapeHtml(withdrawal.rejectReason)}` : undefined,
    ...commandHint
  ].filter(Boolean).join("\n");
}

function adminWithdrawalKeyboard(withdrawal: Withdrawal, rejectExpanded = false) {
  if (withdrawal.status !== "pending") {
    return Markup.inlineKeyboard([
      [Markup.button.callback(`Status: ${withdrawal.status}`, "noop")],
      [
        Markup.button.callback("Profile", `admin:withdraw:user:${withdrawal.userId}`),
        Markup.button.callback("History", `admin:withdraw:history:${withdrawal.userId}`)
      ]
    ]);
  }

  if (rejectExpanded) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("Wrong account", `admin:withdraw:reject:${withdrawal.id}:wrong_account`),
        Markup.button.callback("Suspicious", `admin:withdraw:reject:${withdrawal.id}:suspicious`)
      ],
      [
        Markup.button.callback("Duplicate", `admin:withdraw:reject:${withdrawal.id}:duplicate`),
        Markup.button.callback("User request", `admin:withdraw:reject:${withdrawal.id}:user_request`)
      ],
      [Markup.button.callback("Custom reason", `admin:withdraw:custom:${withdrawal.id}`)],
      [Markup.button.callback("Back", `admin:withdraw:back:${withdrawal.id}`)]
    ]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Approve / Paid", `admin:withdraw:pay:${withdrawal.id}`),
      Markup.button.callback("Reject", `admin:withdraw:reject_menu:${withdrawal.id}`)
    ],
    [
      Markup.button.callback("Profile", `admin:withdraw:user:${withdrawal.userId}`),
      Markup.button.callback("History", `admin:withdraw:history:${withdrawal.userId}`)
    ]
  ]);
}

function withdrawalPresetRejectReason(reason: string): string {
  if (reason === "wrong_account") return "Wrong payout account";
  if (reason === "suspicious") return "Suspicious withdrawal request";
  if (reason === "duplicate") return "Duplicate withdrawal request";
  if (reason === "user_request") return "Cancelled by user request";
  return "Rejected by admin";
}

function formatWithdrawalPanelStatus(withdrawal: Withdrawal): string {
  if (withdrawal.status === "paid") return "✅ Paid";
  if (withdrawal.status === "rejected") return "❌ Rejected";
  return "⏳ Pending";
}

function formatAdminUser(user: { username?: string; firstName?: string } | undefined, userId: number): string {
  const name = user?.firstName || user?.username;
  const username = user?.username ? ` (@${user.username})` : "";
  return name ? `${name}${username} / ${userId}` : String(userId);
}

function formatAdminWithdrawalHistory(userId: number): string {
  const withdrawals = store.snapshot().withdrawals.filter((withdrawal) => withdrawal.userId === userId);
  if (withdrawals.length === 0) return `No withdrawals for ${userId}.`;

  return [
    `Withdrawal history for ${userId}`,
    "",
    ...withdrawals.slice(-8).reverse().map((withdrawal) => [
      `${withdrawal.id}: ${withdrawal.status}`,
      `Amount: ${formatMoneyDetail(withdrawal.amount, "en")}`,
      withdrawal.rejectReason ? `Reason: ${withdrawal.rejectReason}` : undefined
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

async function notifyWithdrawalUser(withdrawal: Withdrawal, status: "paid" | "rejected") {
  const user = store.snapshot().users.find((item) => item.id === withdrawal.userId);
  const amount = formatMoneyDetail(withdrawal.amount, user?.language);
  const text = status === "paid"
    ? `✅ Withdrawal paid\n\nID: ${withdrawal.id}\nAmount: ${amount}`
    : `❌ Withdrawal rejected\n\nID: ${withdrawal.id}\nAmount: ${amount}\nReason: ${withdrawal.rejectReason ?? "Rejected by admin"}`;
  await sendTelegramMessageSafe(withdrawal.userId, text);
}

async function acknowledgeAdminCommand(ctx: Context, text: string) {
  if (config.adminConsoleGroupId && ctx.chat?.id === config.adminConsoleGroupId) return;
  await ctx.reply(text);
}

function disputeListKeyboard(disputes: Dispute[]) {
  if (disputes.length === 0) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("No open disputes", "noop")],
      [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
    ]);
  }

  return Markup.inlineKeyboard(
    [
      ...disputes.slice(0, 10).map((dispute) => [
        Markup.button.callback(`Pay ${shortId(dispute.id)}`, `dispute:pay:${dispute.id}`),
        Markup.button.callback(`Uphold ${shortId(dispute.id)}`, `dispute:uphold:${dispute.id}`)
      ]),
      [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
    ]
  );
}

function formatOpenDisputes(): string {
  const disputes = store.snapshot().disputes.filter((dispute) => dispute.status === "open");
  if (disputes.length === 0) return "No open disputes.";

  return [
    `Open disputes: ${disputes.length}`,
    "",
    ...disputes.slice(0, 10).map((dispute) => [
      `Dispute: ${dispute.id}`,
      `Submission: ${dispute.submissionId}`,
      `Worker: ${dispute.workerId}`,
      `Buyer: ${dispute.buyerId}`,
      `Reason: ${dispute.reason}`
    ].join("\n"))
  ].join("\n\n");
}

function buyerSubmissionKeyboard(submissions: Submission[]) {
  if (submissions.length === 0) {
    return Markup.inlineKeyboard([[Markup.button.callback("No pending submissions", "noop")]]);
  }

  return Markup.inlineKeyboard(
    submissions.slice(0, 8).map((submission) => [
      Markup.button.callback(`Review ${shortId(submission.id)}`, `submission:view:${submission.id}`)
    ])
  );
}

function adminSubmissionListKeyboard(submissions: Submission[]) {
  if (submissions.length === 0) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("No pending submissions", "noop")],
      [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
    ]);
  }

  return Markup.inlineKeyboard([
    ...submissions.slice(0, 8).map((submission) => [
      Markup.button.callback(`Review ${shortId(submission.id)}`, `submission:view:${submission.id}`)
    ]),
    [Markup.button.callback("⬅️ Dashboard", "admin:dashboard")]
  ]);
}

function submissionReviewKeyboard(submissionId: string, status: Submission["status"]) {
  if (status !== "pending") {
    return Markup.inlineKeyboard([[Markup.button.callback("Already reviewed", "noop")]]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Approve", `submission:approve:${submissionId}`),
      Markup.button.callback("Reject", `submission:reject:${submissionId}`)
    ]
  ]);
}

function formatSubmissionReview(submissionId: string): string {
  const state = store.snapshot();
  const submission = state.submissions.find((item) => item.id === submissionId);
  if (!submission) return "Submission not found.";
  const task = state.tasks.find((item) => item.id === submission.taskId);

  return [
    `Submission: ${submission.id}`,
    `Status: ${submission.status}`,
    `Task: ${task?.title ?? submission.taskId}`,
    `Worker: ${submission.workerId}`,
    `Reward: ${formatMoney(submission.rewardAmount, "en")}`,
    submission.rejectReason ? `Reject reason: ${submission.rejectReason}` : undefined,
    "",
    "Proof:",
    submission.proof ?? "No proof"
  ].filter(Boolean).join("\n");
}

async function sendSubmissionReview(ctx: Context, submissionId: string) {
  const submission = store.snapshot().submissions.find((item) => item.id === submissionId);
  if (!submission) {
    await ctx.reply("Submission not found.");
    return;
  }

  await showScreen(ctx, formatSubmissionReview(submission.id), submissionReviewKeyboard(submission.id, submission.status));
  await sendProofPreview(ctx, submission.proof);
}

async function sendProofPreview(ctx: Context, proof?: string) {
  if (!proof || !ctx.chat?.id) return;

  const preview = parseProofPreview(proof);
  if (!preview) return;

  try {
    if (preview.type === "photo") {
      await ctx.telegram.sendPhoto(ctx.chat.id, preview.fileId, { caption: preview.caption ?? "Proof photo" });
      return;
    }

    await ctx.telegram.sendDocument(ctx.chat.id, preview.fileId, { caption: preview.caption ?? preview.name ?? "Proof document" });
  } catch (error) {
    await ctx.reply(`Proof preview could not be loaded. Telegram file reference: ${preview.fileId}`);
  }
}

function parseProofPreview(proof: string): { type: "photo" | "document"; fileId: string; caption?: string; name?: string } | undefined {
  const match = /^(photo|document):(\S+)/.exec(proof);
  if (!match) return undefined;

  const caption = /caption="([^"]*)"/.exec(proof)?.[1];
  const name = /name="([^"]*)"/.exec(proof)?.[1];
  return {
    type: match[1] as "photo" | "document",
    fileId: match[2],
    caption,
    name
  };
}

async function approveSubmissionById(submissionId: string, reviewerId: number) {
  assertCanReviewSubmission(submissionId, reviewerId);
  const result = approveSubmission(store.snapshot(), submissionId);
  await store.updateSubmission(result.submission);
  await store.updateTask(result.task);
  await store.addTransaction(result.earnTransaction);
  await store.addTransaction(result.escrowReleaseTransaction);
  await refreshUserTrustLevel(result.submission.workerId);
  if (isAdminUser(reviewerId) && hasAdminPermission(reviewerId, "review")) {
    await addAdminAudit({
      adminId: reviewerId,
      action: "approve_submission",
      targetType: "submission",
      targetId: result.submission.id,
      note: `${result.submission.rewardAmount} BDT`
    });
  }

  return {
    workerId: result.submission.workerId,
    rewardAmount: result.submission.rewardAmount
  };
}

async function rejectSubmissionById(submissionId: string, reason: string, reviewerId: number) {
  assertCanReviewSubmission(submissionId, reviewerId);
  const submission = rejectSubmission(store.snapshot(), submissionId, reason);
  await store.updateSubmission(submission);
  await refreshUserTrustLevel(submission.workerId);
  if (isAdminUser(reviewerId) && hasAdminPermission(reviewerId, "review")) {
    await addAdminAudit({
      adminId: reviewerId,
      action: "reject_submission",
      targetType: "submission",
      targetId: submission.id,
      note: reason
    });
  }
  return submission;
}

function assertCanReviewSubmission(submissionId: string, reviewerId: number) {
  const state = store.snapshot();
  const submission = state.submissions.find((item) => item.id === submissionId);
  if (!submission) throw new Error("Submission not found");
  const task = state.tasks.find((item) => item.id === submission.taskId);
  if (!task) throw new Error("Task not found");
  if (task.buyerId !== reviewerId && !(isAdminUser(reviewerId) && hasAdminPermission(reviewerId, "review"))) {
    throw new Error("You do not have permission to review this submission.");
  }
}

async function payWithdrawalById(withdrawalId: string) {
  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) throw new Error("Withdrawal not found.");
  if (withdrawal.status !== "pending") throw new Error(`Withdrawal already ${withdrawal.status}.`);

  const paidWithdrawal: Withdrawal = {
    ...withdrawal,
    status: "paid",
    reviewedAt: new Date().toISOString()
  };
  await store.updateWithdrawal(paidWithdrawal);
  await store.addTransaction(createTransaction({
    userId: withdrawal.userId,
    type: "withdraw_paid",
    amount: withdrawal.amount,
    note: withdrawal.method
  }));
  return paidWithdrawal;
}

async function approveDepositById(depositId: string) {
  const deposit = store.snapshot().deposits.find((item) => item.id === depositId);
  if (!deposit) throw new Error("Deposit request not found.");
  if (deposit.status !== "pending") throw new Error(`Deposit already ${deposit.status}.`);

  const approvedDeposit: DepositRequest = {
    ...deposit,
    status: "approved",
    reviewedAt: new Date().toISOString()
  };
  await store.updateDeposit(approvedDeposit);
  await store.addTransaction(createTransaction({
    userId: deposit.userId,
    type: "deposit",
    amount: deposit.amount,
    note: `${deposit.method}: ${deposit.proof ?? "approved deposit request"}`
  }));
  return approvedDeposit;
}

async function rejectDepositById(depositId: string, reason: string) {
  const deposit = store.snapshot().deposits.find((item) => item.id === depositId);
  if (!deposit) throw new Error("Deposit request not found.");
  if (deposit.status !== "pending") throw new Error(`Deposit already ${deposit.status}.`);

  const rejectedDeposit: DepositRequest = {
    ...deposit,
    status: "rejected",
    reviewedAt: new Date().toISOString()
  };
  await store.updateDeposit(rejectedDeposit);
  await store.addTransaction(createTransaction({
    userId: deposit.userId,
    type: "deposit_rejected",
    amount: deposit.amount,
    status: "rejected",
    note: reason
  }));
  return rejectedDeposit;
}

async function openDispute(submissionId: string, workerId: number, reason: string) {
  const state = store.snapshot();
  const submission = state.submissions.find((item) => item.id === submissionId);
  if (!submission) throw new Error("Submission not found.");
  if (submission.workerId !== workerId) throw new Error("This submission does not belong to you.");
  if (submission.status !== "rejected") throw new Error("Only rejected submissions can be disputed.");

  const task = state.tasks.find((item) => item.id === submission.taskId);
  if (!task) throw new Error("Task not found.");

  const alreadyOpen = state.disputes.some(
    (dispute) => dispute.submissionId === submission.id && dispute.status === "open"
  );
  if (alreadyOpen) throw new Error("A dispute is already open for this submission.");

  const dispute = createDispute({ submission, task, reason });
  await store.addDispute(dispute);
  return dispute;
}

async function resolveDisputePayWorker(disputeId: string) {
  const state = store.snapshot();
  const dispute = state.disputes.find((item) => item.id === disputeId);
  if (!dispute) throw new Error("Dispute not found.");
  if (dispute.status !== "open") throw new Error(`Dispute already ${dispute.status}.`);

  const submission = state.submissions.find((item) => item.id === dispute.submissionId);
  if (!submission) throw new Error("Submission not found.");
  if (submission.status !== "rejected") throw new Error(`Submission is ${submission.status}, cannot dispute-pay.`);

  const task = state.tasks.find((item) => item.id === submission.taskId);
  if (!task) throw new Error("Task not found.");

  const approvedSubmission: Submission = {
    ...submission,
    status: "approved",
    reviewedAt: new Date().toISOString()
  };
  const updatedTask: Task = {
    ...task,
    completedCount: task.completedCount + 1,
    status: task.completedCount + 1 >= task.workerLimit ? "completed" : task.status,
    updatedAt: new Date().toISOString()
  };
  const resolvedDispute: Dispute = {
    ...dispute,
    status: "worker_paid",
    resolvedAt: new Date().toISOString()
  };

  await store.updateSubmission(approvedSubmission);
  await store.updateTask(updatedTask);
  await store.updateDispute(resolvedDispute);
  await store.addTransaction(createTransaction({
    userId: submission.workerId,
    type: "earn",
    amount: submission.rewardAmount,
    taskId: task.id,
    submissionId: submission.id,
    note: `Dispute resolved in worker favor: ${dispute.id}`
  }));
  await store.addTransaction(createTransaction({
    userId: task.buyerId,
    type: "escrow_release",
    amount: submission.rewardAmount,
    taskId: task.id,
    submissionId: submission.id,
    note: `Dispute payout: ${dispute.id}`
  }));
  await refreshUserTrustLevel(submission.workerId);
  return resolvedDispute;
}

async function resolveDisputeUphold(disputeId: string) {
  const dispute = store.snapshot().disputes.find((item) => item.id === disputeId);
  if (!dispute) throw new Error("Dispute not found.");
  if (dispute.status !== "open") throw new Error(`Dispute already ${dispute.status}.`);

  const resolvedDispute: Dispute = {
    ...dispute,
    status: "rejection_upheld",
    resolvedAt: new Date().toISOString()
  };
  await store.updateDispute(resolvedDispute);
  return resolvedDispute;
}

async function rejectWithdrawalById(withdrawalId: string, reason: string) {
  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) throw new Error("Withdrawal not found.");
  if (withdrawal.status !== "pending") throw new Error(`Withdrawal already ${withdrawal.status}.`);

  const rejectedWithdrawal: Withdrawal = {
    ...withdrawal,
    status: "rejected",
    rejectReason: reason,
    reviewedAt: new Date().toISOString()
  };
  await store.updateWithdrawal(rejectedWithdrawal);
  await store.addTransaction(createTransaction({
    userId: withdrawal.userId,
    type: "withdraw_rejected",
    amount: withdrawal.amount,
    note: reason
  }));
  return rejectedWithdrawal;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}

function campaignListKeyboard(tasks: Task[], language?: "en" | "bn") {
  const messages = getMessages(language);
  return Markup.inlineKeyboard([
    ...tasks.slice(0, 10).map((task) => [
      Markup.button.callback(`${task.title} (${task.status})`, `campaign:view:${task.id}`)
    ]),
    [Markup.button.callback("Campaign History", "menu:campaign_history")],
    [Markup.button.callback(messages.common.back, "menu:home")]
  ]);
}

function campaignEmptyKeyboard(user: { language: "en" | "bn" }) {
  const messages = getMessages(user.language);
  return Markup.inlineKeyboard([
    [Markup.button.callback(user.language === "bn" ? "ক্যাম্পেইন হিস্ট্রি" : "Campaign History", "menu:campaign_history")],
    [Markup.button.callback(messages.common.back, "menu:home")]
  ]);
}

function campaignHistoryKeyboard(language?: "en" | "bn") {
  const messages = getMessages(language);
  return Markup.inlineKeyboard([
    [Markup.button.callback(language === "bn" ? "ক্যাম্পেইনে ফিরুন" : "Back to Campaigns", "menu:campaigns")],
    [Markup.button.callback(messages.common.back, "menu:home")]
  ]);
}

function campaignActionKeyboard(taskId: string, status: TaskStatus, language?: "en" | "bn") {
  const messages = getMessages(language);
  const rows = [];
  if (status === "active") {
    rows.push([Markup.button.callback(language === "bn" ? "Pause করুন" : "Pause", `campaign:pause:${taskId}`)]);
  }
  if (status === "paused") {
    rows.push([Markup.button.callback(language === "bn" ? "Resume করুন" : "Resume", `campaign:resume:${taskId}`)]);
  }
  if (status === "active" || status === "paused") {
    rows.push([Markup.button.callback(language === "bn" ? "বাতিল + Refund" : "Cancel + Refund Unused", `campaign:cancel:${taskId}`)]);
  }
  rows.push([Markup.button.callback(messages.menu.submissions, "menu:submissions")]);
  rows.push([Markup.button.callback(language === "bn" ? "ক্যাম্পেইনে ফিরুন" : "Back to Campaigns", "menu:campaigns"), Markup.button.callback(messages.common.back, "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function formatCampaignList(tasks: Task[], language?: "en" | "bn"): string {
  return [
    getMessages(language).menu.campaigns,
    language === "bn" ? "শুধু active এবং paused campaign" : "Active and paused campaigns only",
    "",
    ...tasks.slice(0, 10).map((task) => {
      const pending = store.snapshot().submissions.filter((submission) => submission.taskId === task.id && submission.status === "pending").length;
      return `- ${task.title}: ${task.status}, ${task.completedCount}/${task.workerLimit}, ${language === "bn" ? "pending" : "pending"} ${pending}`;
    })
  ].join("\n");
}

function formatCampaignHistory(tasks: Task[], language?: "en" | "bn"): string {
  const messages = getMessages(language);
  return [
    language === "bn" ? "ক্যাম্পেইন হিস্ট্রি" : "Campaign History",
    language === "bn" ? "Completed এবং cancelled campaign" : "Completed and cancelled campaigns",
    "",
    ...tasks.slice(0, 10).map((task) => {
      const refunded = store.snapshot().walletTransactions
        .filter((transaction) => transaction.taskId === task.id && transaction.type === "escrow_refund" && transaction.status === "completed")
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      return `- ${task.title}: ${task.status}, ${task.completedCount}/${task.workerLimit}${refunded ? `, refunded ${refunded} BDT` : ""}`;
    })
  ].join("\n");
}

function formatCampaignDetail(taskId: string, language?: "en" | "bn"): string {
  const state = store.snapshot();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return "Campaign not found.";
  const submissions = state.submissions.filter((submission) => submission.taskId === task.id);
  const pending = submissions.filter((submission) => submission.status === "pending").length;
  const approved = submissions.filter((submission) => submission.status === "approved" || submission.status === "auto_approved").length;
  const rejected = submissions.filter((submission) => submission.status === "rejected").length;

  return [
    formatTask(task, language),
    "",
    "Campaign stats:",
    `Pending proof: ${pending}`,
    `Approved/auto: ${approved}`,
    `Rejected: ${rejected}`,
    `Outstanding escrow: ${formatMoney(campaignOutstandingEscrow(task.id), language)}`
  ].join("\n");
}

function getReviewableTask(taskId: string, userId: number): Task {
  const task = store.snapshot().tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("Campaign not found.");
  if (task.buyerId !== userId && !(isAdminUser(userId) && hasAdminPermission(userId, "review"))) {
    throw new Error("You do not have permission to manage this campaign.");
  }
  return task;
}

async function updateCampaignStatus(taskId: string, userId: number, status: Extract<TaskStatus, "active" | "paused">) {
  const task = getReviewableTask(taskId, userId);
  if (task.status === "completed" || task.status === "cancelled") {
    throw new Error(`Campaign already ${task.status}.`);
  }
  const updatedTask: Task = {
    ...task,
    status,
    updatedAt: new Date().toISOString()
  };
  await store.updateTask(updatedTask);
  return updatedTask;
}

async function cancelCampaign(taskId: string, userId: number) {
  const task = getReviewableTask(taskId, userId);
  if (task.status === "completed" || task.status === "cancelled") {
    throw new Error(`Campaign already ${task.status}.`);
  }

  const pendingCount = store.snapshot().submissions.filter(
    (submission) => submission.taskId === task.id && submission.status === "pending"
  ).length;
  if (pendingCount > 0) {
    throw new Error("Approve or reject pending submissions before cancelling this campaign.");
  }

  const refundAmount = campaignOutstandingEscrow(task.id);
  const updatedTask: Task = {
    ...task,
    status: "cancelled",
    updatedAt: new Date().toISOString()
  };

  await store.updateTask(updatedTask);
  if (refundAmount > 0) {
    await store.addTransaction(createTransaction({
      userId: task.buyerId,
      type: "escrow_refund",
      amount: refundAmount,
      taskId: task.id,
      note: "Unused campaign escrow refund"
    }));
  }

  return { task: updatedTask, refundAmount };
}

function campaignOutstandingEscrow(taskId: string): number {
  const outstanding = store.snapshot().walletTransactions
    .filter((transaction) => transaction.taskId === taskId && transaction.status === "completed")
    .reduce((sum, transaction) => {
      if (transaction.type === "escrow_lock") return sum + transaction.amount;
      if (transaction.type === "escrow_release" || transaction.type === "escrow_refund") return sum - transaction.amount;
      return sum;
    }, 0);

  return Math.round(Math.max(outstanding, 0) * 100) / 100;
}

function assertCampaignTargetAllowed(newTask: Task) {
  if (!newTask.verificationTarget) return;
  if (newTask.verificationType === "telegram_join") {
    const chatId = telegramChatIdFromTask(newTask);
    const trackedChat = chatId ? store.snapshot().trackedChats.find((chat) => chat.id === chatId) : undefined;
    if (!trackedChat?.canVerifyMembers) {
      throw new Error("Add the bot as an admin in this channel/group first, then send the same numeric chat ID again.");
    }
    if (trackedChat.canInviteUsers === false) {
      throw new Error("The bot is admin, but invite-link permission is missing. Enable invite users / create invite links permission.");
    }
  }

  const duplicate = store.snapshot().tasks.find((task) =>
    task.buyerId === newTask.buyerId &&
    task.status === "active" &&
    task.verificationType === newTask.verificationType &&
    task.verificationTarget === newTask.verificationTarget
  );
  if (duplicate) {
    throw new Error(`An active campaign already uses this same target: ${duplicate.title}`);
  }
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const requestUrl = new URL(request.url ?? "/", publicBaseUrl());

  if (requestUrl.pathname === telegramWebhookPath && telegramWebhookCallback) {
    await telegramWebhookCallback(request, response);
    return;
  }

  if (requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: botRuntime.launchState === "running", ...runtime, bot: botRuntime }));
    return;
  }

  if (requestUrl.pathname === "/track/visit") {
    await handleWebsiteVisitTrack(request, response, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/track/complete") {
    await handleWebsiteVisitComplete(response, requestUrl);
    return;
  }

  if (requestUrl.pathname.startsWith("/geni/go/")) {
    await handleGeniStart(request, response, requestUrl);
    return;
  }

  if (requestUrl.pathname.startsWith("/geni/done/")) {
    await handleGeniDone(request, response, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/verify") {
    await handleApiVerification(request, response, requestUrl);
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Neosence Bot is running");
}

async function handleWebsiteVisitTrack(request: IncomingMessage, response: ServerResponse, requestUrl: URL) {
  const taskId = requestUrl.searchParams.get("taskId") ?? "";
  const workerId = Number(requestUrl.searchParams.get("workerId"));
  const state = store.snapshot();
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task || task.verificationType !== "website_visit" || !Number.isFinite(workerId)) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("Invalid Neosence tracking link.");
    return;
  }

  const seconds = task.websiteVisitSeconds ?? 30;
  const completeUrl = new URL("/track/complete", requestPublicBaseUrl(request));
  completeUrl.searchParams.set("taskId", taskId);
  completeUrl.searchParams.set("workerId", String(workerId));
  completeUrl.searchParams.set("ip", String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? ""));
  completeUrl.searchParams.set("ua", String(request.headers["user-agent"] ?? "unknown").slice(0, 160));

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(renderTimerPage({
    seconds,
    completeUrl: completeUrl.toString(),
    targetUrl: task.verificationTarget
  }));
}

async function handleWebsiteVisitComplete(response: ServerResponse, requestUrl: URL) {
  const taskId = requestUrl.searchParams.get("taskId") ?? "";
  const workerId = Number(requestUrl.searchParams.get("workerId"));
  const ip = requestUrl.searchParams.get("ip") ?? "unknown";
  const userAgent = requestUrl.searchParams.get("ua") ?? "unknown";
  const task = store.snapshot().tasks.find((item) => item.id === taskId);

  if (!task || task.verificationType !== "website_visit" || !Number.isFinite(workerId)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "invalid_tracking_request" }));
    return;
  }

  const alreadySubmitted = store.snapshot().submissions.some(
    (submission) => submission.taskId === task.id && submission.workerId === workerId
  );

  const fraudReason = websiteVisitFraudReason(task, workerId, ip, userAgent);
  if (fraudReason) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId,
      workerId,
      type: "website_visit",
      status: "failed",
      metadata: { ip, userAgent, fraudReason, seconds: task.websiteVisitSeconds ?? 30 }
    }));
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: fraudReason }));
    return;
  }

  if (!alreadySubmitted) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId,
      workerId,
      type: "website_visit",
      status: "passed",
      metadata: {
        ip,
        userAgent,
        seconds: task.websiteVisitSeconds ?? 30
      }
    }));

    try {
      await completeAutoTask(task, workerId, "website_visit_timer_completed", "Website visit timer completed");
      await bot.telegram.sendMessage(workerId, `Website visit verified. ${task.rewardPerWorker} BDT added to your wallet.`);
    } catch {
      // Verify Now remains as fallback if auto payout races or fails.
    }
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
}

function websiteVisitFraudReason(task: Task, workerId: number, ip: string, userAgent: string): string | undefined {
  const state = store.snapshot();
  const normalizedIp = normalizeFingerprint(ip);
  const normalizedUa = normalizeFingerprint(userAgent);
  const passedEvents = state.verificationEvents.filter(
    (event) => event.taskId === task.id && event.type === "website_visit" && event.status === "passed"
  );

  const sameWorker = state.submissions.some((submission) => submission.taskId === task.id && submission.workerId === workerId);
  if (sameWorker) return "worker_already_completed";

  if (normalizedIp !== "unknown") {
    const sameIp = passedEvents.find((event) => normalizeFingerprint(String(event.metadata.ip ?? "unknown")) === normalizedIp);
    if (sameIp && sameIp.workerId !== workerId) return "duplicate_ip_for_task";
  }

  if (normalizedUa !== "unknown") {
    const sameDeviceCount = passedEvents.filter(
      (event) => normalizeFingerprint(String(event.metadata.userAgent ?? "unknown")) === normalizedUa
    ).length;
    if (sameDeviceCount >= 2) return "duplicate_device_for_task";
  }

  return undefined;
}

function normalizeFingerprint(value: string): string {
  return value.split(",")[0]?.trim().toLowerCase() || "unknown";
}

async function handleGeniStart(request: IncomingMessage, response: ServerResponse, requestUrl: URL) {
  const linkId = pathTail(requestUrl.pathname, "/geni/go/");
  const link = store.snapshot().geniLinks.find((item) => item.id === linkId);
  if (!link || link.status === "archived") {
    writeHtml(response, 404, renderGeniMessagePage("GENI link not found", "This experimental tracking link is not available."));
    return;
  }
  if (link.status === "paused") {
    writeHtml(response, 423, renderGeniMessagePage("GENI link paused", "This experimental tracking link is paused."));
    return;
  }

  const now = new Date().toISOString();
  const userAgent = String(request.headers["user-agent"] ?? "unknown").slice(0, 220);
  const deviceInfo = deviceInfoFromUserAgent(userAgent);
  const visit: GeniVisit = {
    id: compactId("gv"),
    linkId: link.id,
    sessionId: compactId("gs"),
    status: "started",
    ip: requestIp(request),
    userAgent,
    country: countryFromRequest(request),
    deviceType: deviceInfo.deviceType,
    browser: deviceInfo.browser,
    referrer: String(request.headers.referer ?? request.headers.referrer ?? "").slice(0, 300) || undefined,
    suspectReason: geniStartSuspectReason(request),
    startedAt: now,
    updatedAt: now
  };
  await store.upsertGeniVisit(visit);

  const cookie = `geni_${link.id}=${visit.sessionId}; Max-Age=21600; Path=/geni; HttpOnly; SameSite=Lax; Secure`;
  if (!link.shortenerUrl) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": cookie });
    response.end(renderGeniMessagePage(
      "GENI start tracked",
      "Shortener URL is not set yet. Add the paid shortener URL from the admin panel.",
      geniFinalUrl(link.id)
    ));
    return;
  }

  response.writeHead(302, {
    location: link.shortenerUrl,
    "set-cookie": cookie,
    "cache-control": "no-store"
  });
  response.end();
}

async function handleGeniDone(request: IncomingMessage, response: ServerResponse, requestUrl: URL) {
  const linkId = pathTail(requestUrl.pathname, "/geni/done/");
  const link = store.snapshot().geniLinks.find((item) => item.id === linkId);
  if (!link || link.status === "archived") {
    writeHtml(response, 404, renderGeniMessagePage("GENI link not found", "This experimental tracking link is not available."));
    return;
  }

  const sessionId = requestUrl.searchParams.get("sid") ?? cookieValue(request.headers.cookie, `geni_${link.id}`);
  const state = store.snapshot();
  const existing = sessionId
    ? state.geniVisits.find((item) => item.linkId === link.id && item.sessionId === sessionId)
    : undefined;
  const now = new Date().toISOString();
  const suspectReason = geniCompletionSuspectReason(request, link.id, existing);
  const userAgent = String(request.headers["user-agent"] ?? "unknown").slice(0, 220);
  const deviceInfo = deviceInfoFromUserAgent(userAgent);
  const visit: GeniVisit = existing
    ? {
      ...existing,
      status: "completed",
      ip: existing.ip ?? requestIp(request),
      userAgent: existing.userAgent ?? userAgent,
      country: existing.country ?? countryFromRequest(request),
      deviceType: existing.deviceType ?? deviceInfo.deviceType,
      browser: existing.browser ?? deviceInfo.browser,
      referrer: existing.referrer ?? (String(request.headers.referer ?? request.headers.referrer ?? "").slice(0, 300) || undefined),
      suspectReason: existing.suspectReason ?? suspectReason,
      completedAt: existing.completedAt ?? now,
      updatedAt: now
    }
    : {
      id: compactId("gv"),
      linkId: link.id,
      sessionId: sessionId ?? compactId("direct"),
      status: "completed",
      ip: requestIp(request),
      userAgent,
      country: countryFromRequest(request),
      deviceType: deviceInfo.deviceType,
      browser: deviceInfo.browser,
      referrer: String(request.headers.referer ?? request.headers.referrer ?? "").slice(0, 300) || undefined,
      suspectReason: suspectReason ?? "no_start_session",
      startedAt: now,
      completedAt: now,
      updatedAt: now
    };

  await store.upsertGeniVisit(visit);
  writeHtml(response, 200, renderGeniDonePage(link, visit));
}

async function handleGeniTelegramVerify(ctx: Context & { from: TelegramFrom }, payload: string) {
  const visitId = payload.replace(/^geni_/, "");
  const visit = store.snapshot().geniVisits.find((item) => item.id === visitId);
  if (!visit) {
    await ctx.reply("GENI visit not found or expired.");
    return;
  }

  const link = store.snapshot().geniLinks.find((item) => item.id === visit.linkId);
  const updated: GeniVisit = {
    ...visit,
    telegramUserId: ctx.from.id,
    updatedAt: new Date().toISOString()
  };
  await store.upsertGeniVisit(updated);
  await ctx.reply([
    "🧪 GENI visit verified",
    "",
    `Link: ${link?.name ?? visit.linkId}`,
    `Status: ${visit.status}`,
    "Your Telegram account is now attached to this completed visit."
  ].join("\n"));
}

function geniStartSuspectReason(request: IncomingMessage): string | undefined {
  const settings = geniSettings();
  const userAgent = normalizeFingerprint(String(request.headers["user-agent"] ?? "unknown"));
  if (settings.blockBotUserAgents && isBotUserAgent(userAgent)) return "bot_user_agent";
  return undefined;
}

function geniCompletionSuspectReason(request: IncomingMessage, linkId: string, existing?: GeniVisit): string | undefined {
  const settings = geniSettings();
  if (!existing) return settings.flagDirectFinalHits ? "no_start_session" : undefined;
  const userAgent = normalizeFingerprint(String(request.headers["user-agent"] ?? "unknown"));
  if (settings.blockBotUserAgents && isBotUserAgent(userAgent)) return "bot_user_agent";

  const ip = normalizeFingerprint(existing.ip ?? requestIp(request));
  if (ip !== "unknown") {
    const sameIpCompleted = store.snapshot().geniVisits.filter((item) =>
      item.linkId === linkId &&
      item.status === "completed" &&
      item.id !== existing.id &&
      normalizeFingerprint(item.ip ?? "unknown") === ip
    ).length;
    if (sameIpCompleted >= settings.sameIpLimit) return "high_repeat_ip";
  }

  const normalizedDevice = normalizeFingerprint(existing.userAgent ?? userAgent);
  if (normalizedDevice !== "unknown") {
    const sameDeviceCompleted = store.snapshot().geniVisits.filter((item) =>
      item.linkId === linkId &&
      item.status === "completed" &&
      item.id !== existing.id &&
      normalizeFingerprint(item.userAgent ?? "unknown") === normalizedDevice
    ).length;
    if (sameDeviceCompleted >= settings.sameDeviceLimit) return "high_repeat_device";
  }

  return existing.suspectReason;
}

function isBotUserAgent(userAgent: string): boolean {
  return userAgent.includes("bot") || userAgent.includes("crawler") || userAgent.includes("spider") || userAgent.includes("headless");
}

function pathTail(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "");
}

function requestIp(request: IncomingMessage): string {
  return String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}

function countryFromRequest(request: IncomingMessage): string {
  const raw = String(
    request.headers["cf-ipcountry"] ??
    request.headers["x-vercel-ip-country"] ??
    request.headers["cloudfront-viewer-country"] ??
    request.headers["x-country-code"] ??
    ""
  ).split(",")[0].trim().toUpperCase();
  if (!raw || raw === "XX") return "Unknown";
  return raw.slice(0, 3);
}

function deviceInfoFromUserAgent(userAgent: string): { deviceType: string; browser: string } {
  const normalized = userAgent.toLowerCase();
  const deviceType = isBotUserAgent(normalized)
    ? "Bot"
    : normalized.includes("ipad") || normalized.includes("tablet")
      ? "Tablet"
      : normalized.includes("mobile") || normalized.includes("android") || normalized.includes("iphone")
        ? "Mobile"
        : "Desktop";
  const browser = normalized.includes("edg/")
    ? "Edge"
    : normalized.includes("opr/") || normalized.includes("opera")
      ? "Opera"
      : normalized.includes("firefox/")
        ? "Firefox"
        : normalized.includes("safari/") && !normalized.includes("chrome/")
          ? "Safari"
          : normalized.includes("chrome/") || normalized.includes("chromium/")
            ? "Chrome"
            : isBotUserAgent(normalized)
              ? "Bot"
              : "Other";
  return { deviceType, browser };
}

function cookieValue(cookieHeader: string | string[] | undefined, key: string): string | undefined {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  if (!raw) return undefined;
  const cookies = raw.split(";").map((item) => item.trim());
  const pair = cookies.find((item) => item.startsWith(`${key}=`));
  return pair ? decodeURIComponent(pair.slice(key.length + 1)) : undefined;
}

async function handleApiVerification(request: IncomingMessage, response: ServerResponse, requestUrl: URL) {
  if (request.method !== "POST") {
    writeJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const payload: ApiVerificationPayload = {
      taskId: String(body.taskId ?? requestUrl.searchParams.get("taskId") ?? ""),
      workerId: Number(body.workerId ?? requestUrl.searchParams.get("workerId")),
      secret: stringOrUndefined(body.secret ?? requestUrl.searchParams.get("secret")),
      proof: stringOrUndefined(body.proof),
      event: stringOrUndefined(body.event),
      code: stringOrUndefined(body.code)
    };
    const result = await completeApiVerifiedTask(payload);
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, 400, { ok: false, error: (error as Error).message });
  }
}

async function completeApiVerifiedTask(payload: ApiVerificationPayload) {
  if (!payload.taskId || !Number.isFinite(payload.workerId)) throw new Error("invalid_payload");

  const task = store.snapshot().tasks.find((item) => item.id === payload.taskId);
  if (!task) throw new Error("task_not_found");
  if (!["website_webhook", "app_attribution", "in_app_code"].includes(task.verificationType ?? "")) {
    throw new Error("task_does_not_use_api_verification");
  }
  const verificationType = task.verificationType as Extract<VerificationType, "website_webhook" | "app_attribution" | "in_app_code">;

  assertApiSecret(task, payload.secret);
  if (verificationType === "in_app_code" && payload.code && normalizeAnswer(payload.code) !== normalizeAnswer(task.verificationTarget ?? "")) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId: task.id,
      workerId: payload.workerId,
      type: verificationType,
      status: "failed",
      metadata: { event: payload.event, reason: "code_mismatch" }
    }));
    throw new Error("code_mismatch");
  }

  await store.addVerificationEvent(createVerificationEvent({
    taskId: task.id,
    workerId: payload.workerId,
    type: verificationType,
    status: "passed",
    metadata: { event: payload.event ?? "api_verified" }
  }));
  await completeAutoTask(task, payload.workerId, payload.proof ?? `${verificationType}_api_verified`, "API/webhook verified");
  await bot.telegram.sendMessage(payload.workerId, `Task verified. ${task.rewardPerWorker} BDT added to your wallet.`);
  return { ok: true, taskId: task.id, workerId: payload.workerId };
}

function assertApiSecret(task: Task, secret?: string) {
  const expected = config.webhookSecret ?? task.verificationTarget;
  if (!expected) throw new Error("webhook_secret_not_configured");
  if (secret !== expected) throw new Error("invalid_secret");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 64 * 1024) throw new Error("payload_too_large");
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeHtml(response: ServerResponse, status: number, html: string) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function renderGeniDonePage(link: GeniLink, visit: GeniVisit): string {
  const verifyUrl = telegramBotStartUrl(`geni_${visit.id}`);
  const verifyButton = verifyUrl
    ? `<a class="button" href="${escapeHtml(verifyUrl)}">Verify in Telegram</a>`
    : "";
  const suspect = visit.suspectReason
    ? `<p class="notice">Review flag: ${escapeHtml(visit.suspectReason)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neosence GENI</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f3ee; color: #1f2933; font-family: Arial, sans-serif; }
    main { width: min(620px, calc(100vw - 32px)); }
    .panel { border: 1px solid #d8d4cc; border-radius: 10px; padding: 30px; background: #fffdfa; box-shadow: 0 12px 34px rgba(31, 41, 51, 0.10); }
    .brand { font-size: 14px; font-weight: 700; letter-spacing: 0; color: #0f766e; margin-bottom: 18px; }
    h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0 0 14px; line-height: 1.55; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
    .item { border: 1px solid #e6e1d8; border-radius: 8px; padding: 12px; background: #fbf8f2; }
    .label { display: block; color: #68737d; font-size: 12px; margin-bottom: 4px; }
    .value { font-weight: 700; overflow-wrap: anywhere; }
    .button { display: inline-block; margin-top: 8px; padding: 12px 18px; border-radius: 8px; background: #0f766e; color: #ffffff; text-decoration: none; font-weight: 700; }
    .notice { color: #92400e; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 10px 12px; }
    @media (max-width: 520px) { .panel { padding: 22px; } .meta { grid-template-columns: 1fr; } h1 { font-size: 26px; } }
  </style>
</head>
<body>
  <main class="panel">
    <div class="brand">Neosence GENI</div>
    <h1>Visit Recorded</h1>
    <p>Your visit reached the final destination page.</p>
    <div class="meta">
      <div class="item"><span class="label">Link</span><span class="value">${escapeHtml(link.name)}</span></div>
      <div class="item"><span class="label">Visit</span><span class="value">${escapeHtml(shortId(visit.id))}</span></div>
      <div class="item"><span class="label">Country</span><span class="value">${escapeHtml(visit.country ?? "Unknown")}</span></div>
      <div class="item"><span class="label">Device</span><span class="value">${escapeHtml(visit.deviceType ?? "Unknown")}</span></div>
    </div>
    ${suspect}
    ${verifyButton}
  </main>
</body>
</html>`;
}

function renderGeniMessagePage(title: string, message: string, detail?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f3ee; color: #1f2933; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid #d8d4cc; border-radius: 10px; padding: 28px; background: #fffdfa; box-shadow: 0 12px 34px rgba(31, 41, 51, 0.10); }
    .brand { color: #0f766e; font-weight: 700; margin-bottom: 16px; }
    h1 { margin: 0 0 12px; letter-spacing: 0; }
    p { line-height: 1.55; }
    code { display: block; margin-top: 18px; padding: 12px; overflow-wrap: anywhere; background: #fbf8f2; border: 1px solid #e6e1d8; border-radius: 8px; color: #0f766e; }
  </style>
</head>
<body>
  <main>
    <div class="brand">Neosence GENI</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${detail ? `<code>${escapeHtml(detail)}</code>` : ""}
  </main>
</body>
</html>`;
}

function renderTimerPage(input: { seconds: number; completeUrl: string; targetUrl?: string }): string {
  const targetLink = input.targetUrl?.startsWith("http://") || input.targetUrl?.startsWith("https://")
    ? `<p><a href="${escapeHtml(input.targetUrl)}" target="_blank" rel="noopener">Open target website</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neosence Visit Timer</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #f8fafc; }
    main { width: min(520px, calc(100vw - 32px)); text-align: center; }
    .timer { font-size: 56px; font-weight: 700; margin: 20px 0; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <main>
    <h1>Neosence Visit Verification</h1>
    <p>Keep this page open until the timer finishes.</p>
    ${targetLink}
    <div class="timer" id="timer">${input.seconds}s</div>
    <p id="status">Verification running...</p>
  </main>
  <script>
    let remaining = ${input.seconds};
    const timer = document.getElementById("timer");
    const status = document.getElementById("status");
    const interval = setInterval(async () => {
      remaining -= 1;
      timer.textContent = remaining + "s";
      if (remaining <= 0) {
        clearInterval(interval);
        status.textContent = "Completing verification...";
        try {
          const response = await fetch(${JSON.stringify(input.completeUrl)}, { method: "POST" });
          status.textContent = response.ok ? "Verified. Return to Telegram." : "Could not verify. Press Verify Now in Telegram.";
        } catch {
          status.textContent = "Could not verify. Press Verify Now in Telegram.";
        }
      }
    }, 1000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char] ?? char);
}

function publicBaseUrl(): string {
  if (config.publicUrl) return normalizeBaseUrl(config.publicUrl);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${config.port}`;
}

function telegramBotStartUrl(payload: string): string | undefined {
  const username = bot.botInfo?.username;
  if (!username) return undefined;
  return `https://t.me/${username}?start=${encodeURIComponent(payload)}`;
}

function requestPublicBaseUrl(request: IncomingMessage): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "https").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  if (forwardedHost) return `${forwardedProto || "https"}://${forwardedHost}`;
  return publicBaseUrl();
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function websiteVisitTrackingUrl(taskId: string, workerId: number): string {
  const url = new URL("/track/visit", publicBaseUrl());
  url.searchParams.set("taskId", taskId);
  url.searchParams.set("workerId", String(workerId));
  return url.toString();
}

async function verifyTelegramJoin(ctx: Context & { from: TelegramFrom }, taskId: string) {
  const state = store.snapshot();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task?.verificationTarget) {
    await ctx.reply("Verification target missing.");
    return;
  }

  try {
    const chatId = telegramChatIdFromTask(task);
    if (!chatId) {
      await ctx.reply("Verification target missing.");
      return;
    }
    const trackedChat = store.snapshot().trackedChats.find((chat) => chat.id === chatId);
    if (!trackedChat?.canVerifyMembers) {
      await ctx.reply("The bot does not have admin access to this channel/group yet. Ask the buyer to add the bot as an admin.");
      return;
    }
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    const passed = isActiveTelegramMember(member as TelegramChatMemberLike);
    if (!passed) {
      await ctx.reply("Membership was not verified. Join the channel/group, then press Verify Now again.");
      return;
    }

    const existingSubmission = store.snapshot().submissions.find((submission) =>
      submission.taskId === task.id &&
      submission.workerId === ctx.from.id
    );
    if (existingSubmission) {
      await recordTelegramMembershipForJoin(task, ctx.from.id, chatId, undefined, existingSubmission.id);
      await ctx.reply("You already submitted this task.");
      return;
    }

    await store.addVerificationEvent(createVerificationEvent({
      taskId: task.id,
      workerId: ctx.from.id,
      type: "telegram_join",
      status: "passed",
      metadata: { source: "verify_now", chatId }
    }));
    const submission = await completeAutoTask(task, ctx.from.id, "telegram_join_verified", "Telegram join verified");
    await recordTelegramMembershipForJoin(task, ctx.from.id, chatId, undefined, submission.id);
    await ctx.reply(`Verified. ${formatMoneyForUser(ctx.from.id, task.rewardPerWorker)} added to your wallet.`);
  } catch (error) {
    await ctx.reply(`Verification failed. Check that the bot is added to the target channel/group. ${(error as Error).message}`);
  }
}

async function verifyWebsiteVisit(ctx: Context & { from: TelegramFrom }, taskId: string) {
  const state = store.snapshot();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    await ctx.reply("Task not found.");
    return;
  }

  const alreadySubmitted = state.submissions.some((submission) => submission.taskId === task.id && submission.workerId === ctx.from.id);
  if (alreadySubmitted) {
    await ctx.reply("You already submitted this task.");
    return;
  }

  const passed = state.verificationEvents.some(
    (event) => event.taskId === task.id && event.workerId === ctx.from.id && event.type === "website_visit" && event.status === "passed"
  );

  if (!passed) {
    await ctx.reply([
      "Website visit has not been tracked yet.",
      "Open this link, then return to Telegram and press Verify Now again:",
      websiteVisitTrackingUrl(task.id, ctx.from.id)
    ].join("\n"));
    return;
  }

  await completeAutoTask(task, ctx.from.id, "website_visit_tracked", "Website visit tracked");
  await ctx.reply(`Website visit verified. ${task.rewardPerWorker} BDT added to your wallet.`);
}

async function handleQuizAnswer(ctx: Context & { from: TelegramFrom; message: unknown }, taskId: string) {
  const answer = extractText(ctx.message);
  if (!answer) {
    await ctx.reply("Send a text answer.");
    return;
  }

  const task = store.snapshot().tasks.find((item) => item.id === taskId);
  if (!task || task.verificationType !== "quiz" || !task.verificationTarget) {
    quizWaiters.delete(ctx.from.id);
    await ctx.reply("Quiz task not found.");
    return;
  }

  if (normalizeAnswer(answer) !== normalizeAnswer(task.verificationTarget)) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId: task.id,
      workerId: ctx.from.id,
      type: "quiz",
      status: "failed",
      metadata: { answer }
    }));
    await ctx.reply("Answer did not match. Check the instructions, then press Verify Now again.");
    quizWaiters.delete(ctx.from.id);
    return;
  }

  await store.addVerificationEvent(createVerificationEvent({
    taskId: task.id,
    workerId: ctx.from.id,
    type: "quiz",
    status: "passed",
    metadata: { answer: "matched" }
  }));
  try {
    await completeAutoTask(task, ctx.from.id, "quiz_answer_verified", "Quiz answer verified");
    await ctx.reply(`Quiz verified. ${task.rewardPerWorker} BDT added to your wallet.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  } finally {
    quizWaiters.delete(ctx.from.id);
  }
}

async function handleInAppCodeAnswer(ctx: Context & { from: TelegramFrom; message: unknown }, taskId: string) {
  const code = extractText(ctx.message);
  if (!code) {
    await ctx.reply("Send a text code.");
    return;
  }

  const task = store.snapshot().tasks.find((item) => item.id === taskId);
  if (!task || task.verificationType !== "in_app_code" || !task.verificationTarget) {
    codeWaiters.delete(ctx.from.id);
    await ctx.reply("In-app code task not found.");
    return;
  }

  if (normalizeAnswer(code) !== normalizeAnswer(task.verificationTarget)) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId: task.id,
      workerId: ctx.from.id,
      type: "in_app_code",
      status: "failed",
      metadata: { code: "mismatch" }
    }));
    await ctx.reply("Code did not match. Check the app instructions, then press Verify Now again.");
    codeWaiters.delete(ctx.from.id);
    return;
  }

  await store.addVerificationEvent(createVerificationEvent({
    taskId: task.id,
    workerId: ctx.from.id,
    type: "in_app_code",
    status: "passed",
    metadata: { code: "matched" }
  }));

  try {
    await completeAutoTask(task, ctx.from.id, "in_app_code_verified", "In-app code verified");
    await ctx.reply(`Code verified. ${task.rewardPerWorker} BDT added to your wallet.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  } finally {
    codeWaiters.delete(ctx.from.id);
  }
}

async function completeAutoTask(task: Task, workerId: number, proof: string, note: string): Promise<Submission> {
  const alreadySubmitted = store.snapshot().submissions.some(
    (submission) => submission.taskId === task.id && submission.workerId === workerId
  );
  if (alreadySubmitted) throw new Error("You already submitted this task.");
  if (task.status !== "active") throw new Error("This task is not active anymore.");
  if (task.completedCount >= task.workerLimit) throw new Error("This task already has enough workers.");

  const submission = createSubmission(task, workerId, proof);
  const updatedTask = {
    ...task,
    completedCount: task.completedCount + 1,
    status: task.completedCount + 1 >= task.workerLimit ? "completed" as const : task.status,
    updatedAt: new Date().toISOString()
  };
  await store.addSubmission(submission);
  await store.updateTask(updatedTask);
  await store.addTransaction(createTransaction({
    userId: workerId,
    type: "earn",
    amount: task.rewardPerWorker,
    taskId: task.id,
    submissionId: submission.id,
    note: `${note}. Withdraw hold target: ${config.autoWithdrawHoldHours}h`
  }));
  await store.addTransaction(createTransaction({
    userId: task.buyerId,
    type: "escrow_release",
    amount: task.rewardPerWorker,
    taskId: task.id,
    submissionId: submission.id
  }));
  await refreshUserTrustLevel(workerId);
  return submission;
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

function extractProof(message: unknown): string {
  const proofMessage = message as {
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  if (proofMessage.text) return proofMessage.text;
  if (proofMessage.photo?.length) {
    const bestPhoto = proofMessage.photo[proofMessage.photo.length - 1];
    const caption = proofMessage.caption ? ` caption="${proofMessage.caption}"` : "";
    return `photo:${bestPhoto.file_id}${caption}`;
  }
  if (proofMessage.document?.file_id) {
    const fileName = proofMessage.document.file_name ? ` name="${proofMessage.document.file_name}"` : "";
    const caption = proofMessage.caption ? ` caption="${proofMessage.caption}"` : "";
    return `document:${proofMessage.document.file_id}${fileName}${caption}`;
  }
  if (proofMessage.caption) return proofMessage.caption;
  return "proof_received";
}

bot.catch((error) => {
  botRuntime.lastError = error instanceof Error ? error.message : String(error);
  console.error("Bot error", error);
});

try {
  await bot.telegram.getMe();
  await configureTelegramCommands();
  if (shouldUseWebhook()) {
    telegramWebhookCallback = bot.webhookCallback(telegramWebhookPath);
    await bot.telegram.setWebhook(new URL(telegramWebhookPath, publicBaseUrl()).toString(), {
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES]
    });
    console.log(`Telegram webhook enabled at ${telegramWebhookPath}`);
  } else {
    void bot.launch({ allowedUpdates: [...TELEGRAM_ALLOWED_UPDATES] }).catch((error) => {
      botRuntime.launchState = "failed";
      botRuntime.lastError = error instanceof Error ? error.message : String(error);
      console.error("Bot launch failed", error);
    });
  }
  botRuntime.launchState = "running";
  botRuntime.lastError = undefined;
  console.log("Neosence Bot is running");
} catch (error) {
  botRuntime.launchState = "failed";
  botRuntime.lastError = error instanceof Error ? error.message : String(error);
  console.error("Bot launch failed", error);
  throw error;
}
console.log(config.databaseUrl ? "Storage: PostgreSQL" : "Storage: local JSON fallback");

process.once("SIGINT", () => {
  botRuntime.launchState = "stopped";
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  botRuntime.launchState = "stopped";
  bot.stop("SIGTERM");
});

function shouldUseWebhook(): boolean {
  return !publicBaseUrl().startsWith("http://localhost");
}

async function configureTelegramCommands() {
  try {
    await bot.telegram.setMyCommands(PUBLIC_BOT_COMMANDS);
    if (config.adminConsoleGroupId) {
      await bot.telegram.setMyCommands(ADMIN_CONSOLE_COMMANDS, {
        scope: { type: "chat", chat_id: config.adminConsoleGroupId }
      });
    }
    if (config.adminPanelChannelId) {
      await bot.telegram.setMyCommands(ADMIN_PANEL_CHANNEL_COMMANDS, {
        scope: { type: "chat", chat_id: config.adminPanelChannelId }
      });
    }
  } catch (error) {
    console.warn("Failed to configure Telegram commands", error instanceof Error ? error.message : error);
  }
}
