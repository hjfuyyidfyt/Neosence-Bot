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
  getOrCreateUser,
  rejectSubmission,
  switchMode,
  visibleTasks,
  walletSummary
} from "./services.js";
import { formatTask, mainMenu, modeMenu, taskActionButtons, taskButtons } from "./ui.js";
import type { DepositRequest, Dispute, Submission, Task, TaskApprovalType, TaskStatus, VerificationType, Withdrawal } from "./types.js";

const store = createStore({ databaseUrl: config.databaseUrl, dataFile: config.dataFile });

createServer((request, response) => {
  void handleHttpRequest(request, response);
}).listen(config.port, () => {
  console.log(`Health server listening on ${config.port}`);
});

await store.load();

const bot = new Telegraf(config.botToken);
const proofWaiters = new Map<number, string>();
const quizWaiters = new Map<number, string>();
const supportWaiters = new Set<number>();
type TaskDraftStep =
  | "title"
  | "category"
  | "approval"
  | "reward"
  | "workers"
  | "instructions"
  | "verification"
  | "target"
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
}

const taskDrafts = new Map<number, TaskDraft>();

bot.use(async (ctx, next) => {
  if (!ctx.from || isAdmin(ctx.from.id)) {
    await next();
    return;
  }

  const user = store.snapshot().users.find((item) => item.id === ctx.from?.id);
  if (user?.isBanned) {
    await ctx.reply("Your Neosence account is banned. Contact support if this is a mistake.");
    return;
  }

  await next();
});

bot.start(async (ctx) => {
  const wasExistingUser = store.snapshot().users.some((item) => item.id === ctx.from.id);
  const user = await ensureUser(ctx.from);
  const referralMessage = await maybeApplyReferral(getStartPayload(ctx.message.text), user.id, wasExistingUser);
  await ctx.reply(
    [
      "Welcome to Neosence Bot.",
      "",
      `Current workspace: ${formatMode(user.mode)}.`,
      referralMessage
    ].filter(Boolean).join("\n"),
    mainMenu(user)
  );
});

bot.command("mode", async (ctx) => {
  await ensureUser(ctx.from);
  await ctx.reply("Choose how you want to use Neosence right now:", modeMenu());
});

bot.command("earn", async (ctx) => {
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.command("wallet", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatWallet(user.id, user.mode));
});

bot.command("profile", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatUserProfile(user.id), mainMenu(user));
});

bot.command("posttask", async (ctx) => {
  const user = await ensureUser(ctx.from);
  if (user.mode !== "buyer") {
    await ctx.reply("Task post korte Buyer mode-e switch koro.", mainMenu(user));
    return;
  }

  const text = ctx.message.text.replace("/posttask", "").trim();

  if (!text) {
    await startTaskWizard(ctx);
    return;
  }

  const parts = text.split("|").map((item) => item.trim());
  if (parts.length < 6) {
    await ctx.reply("Task create korte minimum 6 fields lagbe. /posttask diye format dekho.");
    return;
  }

  const [title, category, approvalRaw, rewardRaw, workersRaw, instructions, verificationRaw, target] = parts;
  const approvalType = approvalRaw as TaskApprovalType;
  const rewardPerWorker = Number(rewardRaw);
  const workerLimit = Number(workersRaw);

  if (!["manual", "auto"].includes(approvalType) || !Number.isFinite(rewardPerWorker) || !Number.isInteger(workerLimit)) {
    await ctx.reply("Approval type manual/auto hote hobe, reward number hote hobe, workers full number hote hobe.");
    return;
  }

  const task = createTask({
    buyerId: user.id,
    title,
    category,
    instructions,
    rewardPerWorker,
    workerLimit,
    approvalType,
    verificationType: verificationRaw as VerificationType | undefined,
    verificationTarget: target
  });

  await store.addTask(task);
  await store.addTransaction(createTransaction({
    userId: user.id,
    type: "escrow_lock",
    amount: escrowRequired(task),
    taskId: task.id,
    note: "MVP records escrow lock. Connect deposit validation before public launch."
  }));

  await ctx.reply(`Task live hoye geche.\n\n${formatTask(task)}\n\nEscrow locked: ${escrowRequired(task)} BDT`);
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
  await ctx.reply(`Withdrawal request pending: ${withdrawal.id}`);
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
  await ctx.reply(`Deposit request submitted: ${deposit.id}\nAmount: ${deposit.amount} BDT\nStatus: ${deposit.status}`);
});

bot.command("admin", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const state = store.snapshot();
  const pendingDeposits = state.deposits.filter((item) => item.status === "pending");
  const pendingDisputes = state.disputes.filter((item) => item.status === "open");
  const pendingSubmissions = state.submissions.filter((item) => item.status === "pending");
  const pendingWithdrawals = state.withdrawals.filter((item) => item.status === "pending");
  await ctx.reply([
    "Neosence Admin",
    `Users: ${state.users.length}`,
    `Tasks: ${state.tasks.length}`,
    `Pending deposits: ${pendingDeposits.length}`,
    `Pending disputes: ${pendingDisputes.length}`,
    `Pending submissions: ${pendingSubmissions.length}`,
    `Pending withdrawals: ${pendingWithdrawals.length}`,
    "",
    "Use buttons below for quick review.",
    "",
    "Commands:",
    "/deposit <userId> <amount> <note>",
    "/approvedeposit <depositId>",
    "/rejectdeposit <depositId> <reason>",
    "/user <userId>",
    "/ban <userId>",
    "/unban <userId>",
    "/tickets",
    "/closeticket <ticketId>",
    "/disputes",
    "/resolvedispute <disputeId> pay/uphold",
    "/approve <submissionId>",
    "/reject <submissionId> <reason>",
    "/paywithdraw <withdrawalId>",
    "/rejectwithdraw <withdrawalId> <reason>"
  ].join("\n"), adminReviewKeyboard(pendingDeposits, pendingDisputes, pendingSubmissions, pendingWithdrawals));
});

bot.command("disputes", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  await ctx.reply(formatOpenDisputes(), disputeListKeyboard(store.snapshot().disputes.filter((item) => item.status === "open")));
});

bot.command("resolvedispute", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, disputeId, resolution] = ctx.message.text.split(" ");
  if (!disputeId || !["pay", "uphold"].includes(resolution)) {
    await ctx.reply("Format: /resolvedispute <disputeId> pay/uphold");
    return;
  }

  try {
    const dispute = resolution === "pay"
      ? await resolveDisputePayWorker(disputeId)
      : await resolveDisputeUphold(disputeId);
    await ctx.reply(`Dispute resolved: ${dispute.id} (${dispute.status})`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("tickets", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  await ctx.reply(formatOpenTickets());
});

bot.command("closeticket", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, ticketId] = ctx.message.text.split(" ");
  if (!ticketId) {
    await ctx.reply("Format: /closeticket <ticketId>");
    return;
  }

  try {
    const ticket = await closeSupportTicket(ticketId);
    await ctx.reply(`Closed ticket ${ticket.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("ban", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId)) {
    await ctx.reply("Format: /ban <userId>");
    return;
  }

  try {
    const user = await setUserBanStatus(userId, true);
    await ctx.reply(`Banned user ${user.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("unban", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId)) {
    await ctx.reply("Format: /unban <userId>");
    return;
  }

  try {
    const user = await setUserBanStatus(userId, false);
    await ctx.reply(`Unbanned user ${user.id}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("user", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, userIdRaw] = ctx.message.text.split(" ");
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId)) {
    await ctx.reply("Format: /user <userId>");
    return;
  }

  await ctx.reply(formatUserLookup(userId));
});

bot.command("deposit", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
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
  await ctx.reply(`Deposited ${amount} BDT to user ${userId}.`);
});

bot.command("approvedeposit", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, depositId] = ctx.message.text.split(" ");
  if (!depositId) {
    await ctx.reply("Format: /approvedeposit <depositId>");
    return;
  }

  try {
    const deposit = await approveDepositById(depositId);
    await ctx.reply(`Deposit approved: ${deposit.id}\nUser ${deposit.userId} received ${deposit.amount} BDT.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("rejectdeposit", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, depositId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim() || "Rejected by admin";
  if (!depositId) {
    await ctx.reply("Format: /rejectdeposit <depositId> <reason>");
    return;
  }

  try {
    const deposit = await rejectDepositById(depositId, reason);
    await ctx.reply(`Deposit rejected: ${deposit.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("approve", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
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
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
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
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, withdrawalId] = ctx.message.text.split(" ");
  if (!withdrawalId) {
    await ctx.reply("Format: /paywithdraw <withdrawalId>");
    return;
  }

  try {
    const withdrawal = await payWithdrawalById(withdrawalId);
    await ctx.reply(`Withdrawal paid: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.command("rejectwithdraw", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, withdrawalId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim();
  if (!withdrawalId || !reason) {
    await ctx.reply("Format: /rejectwithdraw <withdrawalId> <reason>");
    return;
  }

  try {
    const withdrawal = await rejectWithdrawalById(withdrawalId, reason);
    await ctx.reply(`Withdrawal rejected: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action("menu:earn", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.action("menu:post", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  if (user.mode !== "buyer") {
    await ctx.reply("Task post korte Buyer mode-e switch koro.", mainMenu(user));
    return;
  }
  await startTaskWizard(ctx);
});

bot.action("menu:wallet", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatWallet(user.id, user.mode));
});

bot.action("menu:mode", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Choose mode:", modeMenu());
});

bot.action("menu:jobs", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Use /mytasks to see your accepted jobs and submissions.");
});

bot.action("menu:campaigns", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const tasks = store.snapshot().tasks.filter((task) => task.buyerId === user.id);
  if (tasks.length === 0) {
    await ctx.reply("Ekhono kono campaign nei. Post Task diye first campaign create koro.", mainMenu(user));
    return;
  }

  await ctx.reply(formatCampaignList(tasks), campaignListKeyboard(tasks));
});

bot.action("menu:submissions", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const state = store.snapshot();
  const taskIds = new Set(state.tasks.filter((task) => task.buyerId === user.id).map((task) => task.id));
  const submissions = state.submissions.filter((submission) => taskIds.has(submission.taskId));

  if (submissions.length === 0) {
    await ctx.reply("Ekhono kono campaign submission asheni.");
    return;
  }

  const pending = submissions.filter((submission) => submission.status === "pending");
  await ctx.reply([
    "Recent campaign submissions:",
    ...submissions.slice(0, 10).map((submission) => `- ${submission.id}: ${submission.status}, worker ${submission.workerId}, ${submission.rewardAmount} BDT`)
  ].join("\n"), buyerSubmissionKeyboard(pending));
});

bot.action("menu:withdraw", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatWithdrawHelp(user.id));
});

bot.action("menu:referrals", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatReferralStats(user.id, ctx.botInfo?.username));
});

bot.action("menu:profile", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatUserProfile(user.id), mainMenu(user));
});

bot.action("menu:support", async (ctx) => {
  await ctx.answerCbQuery();
  supportWaiters.add(ctx.from.id);
  await ctx.reply("Support message likho. Next message ticket hisebe admin-er jonno save hobe.");
});

bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action(/^mode:(freelancer|buyer)$/, async (ctx) => {
  const mode = ctx.match[1] as "freelancer" | "buyer";
  const user = await ensureUser(ctx.from);
  const updatedUser = switchMode(user, mode);
  await store.upsertUser(updatedUser);
  await ctx.answerCbQuery(`Mode changed to ${mode}`);
  await ctx.reply(`Workspace changed: ${formatMode(mode)}`, mainMenu(updatedUser));
});

bot.action(/^wizard:approval:(manual|auto)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = taskDrafts.get(ctx.from.id);
  if (!draft) {
    await ctx.reply("Task draft expired. /posttask diye abar shuru koro.");
    return;
  }

  draft.approvalType = ctx.match[1] as TaskApprovalType;
  draft.step = "reward";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply("Reward per worker koto BDT? Example: 5");
});

bot.action(/^wizard:verification:(telegram_join|website_visit|website_webhook|app_attribution|in_app_code|quiz)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = taskDrafts.get(ctx.from.id);
  if (!draft) {
    await ctx.reply("Task draft expired. /posttask diye abar shuru koro.");
    return;
  }

  draft.verificationType = ctx.match[1] as VerificationType;
  draft.step = "target";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(verificationTargetPrompt(draft.verificationType));
});

bot.action("wizard:confirm", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const draft = taskDrafts.get(ctx.from.id);
  if (!draft || !isCompleteDraft(draft)) {
    await ctx.reply("Task draft incomplete. /posttask diye abar shuru koro.");
    return;
  }

  const task = createTask({
    buyerId: user.id,
    title: draft.title,
    category: draft.category,
    instructions: draft.instructions,
    rewardPerWorker: draft.rewardPerWorker,
    workerLimit: draft.workerLimit,
    approvalType: draft.approvalType,
    verificationType: draft.verificationType,
    verificationTarget: draft.verificationTarget
  });

  await store.addTask(task);
  await store.addTransaction(createTransaction({
    userId: user.id,
    type: "escrow_lock",
    amount: escrowRequired(task),
    taskId: task.id,
    note: "MVP records escrow lock. Connect deposit validation before public launch."
  }));
  taskDrafts.delete(ctx.from.id);

  await ctx.reply(`Task live hoye geche.\n\n${formatTask(task)}\n\nEscrow locked: ${escrowRequired(task)} BDT`, mainMenu(user));
});

bot.action("wizard:cancel", async (ctx) => {
  await ctx.answerCbQuery();
  taskDrafts.delete(ctx.from.id);
  const user = await ensureUser(ctx.from);
  await ctx.reply("Task draft cancelled.", mainMenu(user));
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

  if (task.buyerId !== user.id && !isAdmin(user.id)) {
    await ctx.reply("Ei submission dekhar permission nei.");
    return;
  }

  await ctx.reply(formatSubmissionReview(submission.id), submissionReviewKeyboard(submission.id, submission.status));
});

bot.action(/^campaign:view:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const task = getReviewableTask(ctx.match[1], user.id);
    await ctx.reply(formatCampaignDetail(task.id), campaignActionKeyboard(task.id, task.status));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^campaign:pause:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const task = await updateCampaignStatus(ctx.match[1], user.id, "paused");
    await ctx.reply(`Campaign paused: ${task.title}`, campaignActionKeyboard(task.id, task.status));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^campaign:resume:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const task = await updateCampaignStatus(ctx.match[1], user.id, "active");
    await ctx.reply(`Campaign resumed: ${task.title}`, campaignActionKeyboard(task.id, task.status));
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^campaign:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);

  try {
    const result = await cancelCampaign(ctx.match[1], user.id);
    await ctx.reply(`Campaign cancelled: ${result.task.title}\nRefunded: ${result.refundAmount} BDT`);
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
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const withdrawal = await payWithdrawalById(ctx.match[1]);
    await ctx.reply(`Withdrawal paid: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^deposit:approve:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const deposit = await approveDepositById(ctx.match[1]);
    await ctx.reply(`Deposit approved. User ${deposit.userId} received ${deposit.amount} BDT.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^deposit:reject:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const deposit = await rejectDepositById(ctx.match[1], "Rejected by admin");
    await ctx.reply(`Deposit rejected: ${deposit.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^dispute:pay:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const dispute = await resolveDisputePayWorker(ctx.match[1]);
    await ctx.reply(`Dispute resolved. Worker paid for ${dispute.submissionId}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^dispute:uphold:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const dispute = await resolveDisputeUphold(ctx.match[1]);
    await ctx.reply(`Dispute resolved. Rejection upheld for ${dispute.submissionId}.`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^withdrawal:reject:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin permission required.");
    return;
  }

  try {
    const withdrawal = await rejectWithdrawalById(ctx.match[1], "Rejected by admin");
    await ctx.reply(`Withdrawal rejected: ${withdrawal.id}`);
  } catch (error) {
    await ctx.reply((error as Error).message);
  }
});

bot.action(/^task:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  const task = store.snapshot().tasks.find((item) => item.id === ctx.match[1]);
  if (!task) {
    await ctx.reply("Task not found.");
    return;
  }
  await ctx.reply(formatTask(task), taskActionButtons(task));
});

bot.action(/^proof:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  proofWaiters.set(ctx.from.id, ctx.match[1]);
  await ctx.reply("Proof pathao: screenshot caption, text, username, or link. Next message proof hisebe save hobe.");
});

bot.action(/^verify:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
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
    await ctx.reply("Quiz answer/code pathao. Correct hole instant reward add hobe.");
    return;
  }

  await ctx.reply("Ei auto verification integration ekhono connected na. MVP te telegram_join ready, website/app webhook layer next step.");
});

bot.on("message", async (ctx, next) => {
  if (!ctx.from) return next();
  const quizTaskId = quizWaiters.get(ctx.from.id);
  if (quizTaskId) {
    await handleQuizAnswer(ctx, quizTaskId);
    return;
  }

  if (supportWaiters.has(ctx.from.id)) {
    await handleSupportMessage(ctx);
    return;
  }

  const draft = taskDrafts.get(ctx.from.id);
  if (draft) {
    await handleTaskWizardMessage(ctx, draft);
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

async function showEarn(ctx: Context & { from: TelegramFrom }) {
  const userId = ctx.from.id;
  const tasks = visibleTasks(store.snapshot(), userId).slice(0, 10);
  if (tasks.length === 0) {
    await ctx.reply("Ekhon kono available task nai. Buyer mode theke first task post korte paro.");
    return;
  }
  await ctx.reply("Available Neosence tasks:", taskButtons(tasks));
}

function formatWallet(userId: number, mode: "freelancer" | "buyer"): string {
  const wallet = walletSummary(store.snapshot(), userId);
  const common = [
    `User ID: ${userId}`,
    `Available: ${wallet.available} BDT`,
    `Pending: ${wallet.pending} BDT`,
    `Withdrawable: ${wallet.withdrawable} BDT`,
    `Escrow locked: ${wallet.escrow} BDT`,
    `Auto earning hold: ${Math.max(wallet.available - wallet.withdrawable, 0)} BDT`
  ];

  if (mode === "buyer") {
    return [
      "Neosence Buyer Balance",
      ...common,
      "",
      "Deposit:",
      "Send payment to admin/payment number, then submit request:",
      "/depositreq 500 bkash trxid-or-proof-note"
    ].join("\n");
  }

  return [
    "Neosence Freelancer Wallet",
    ...common,
    "",
    "Withdraw:",
    "/withdraw 100 bkash:01XXXXXXXXX"
  ].join("\n");
}

function formatMode(mode: "freelancer" | "buyer"): string {
  return mode === "freelancer" ? "Freelancer Mode" : "Buyer Mode";
}

function formatWithdrawHelp(userId: number): string {
  const wallet = walletSummary(store.snapshot(), userId);
  return [
    "Withdraw Request",
    `Withdrawable: ${wallet.withdrawable} BDT`,
    "",
    "Format:",
    "/withdraw 100 bkash:01XXXXXXXXX"
  ].join("\n");
}

function formatUserProfile(userId: number): string {
  const state = store.snapshot();
  const user = state.users.find((item) => item.id === userId);
  const wallet = walletSummary(state, userId);
  const submissions = state.submissions.filter((submission) => submission.workerId === userId);
  const approved = submissions.filter((submission) => submission.status === "approved" || submission.status === "auto_approved").length;
  const rejected = submissions.filter((submission) => submission.status === "rejected").length;
  const campaigns = state.tasks.filter((task) => task.buyerId === userId);
  const referrals = state.referrals.filter((referral) => referral.referrerId === userId);
  const disputes = state.disputes.filter((dispute) => dispute.workerId === userId);

  return [
    "Neosence Profile",
    `User ID: ${userId}`,
    `Name: ${user?.firstName ?? "Unknown"}`,
    `Username: ${user?.username ? `@${user.username}` : "N/A"}`,
    `Mode: ${user?.mode ?? "N/A"}`,
    `Trust: ${user?.trustLevel ?? calculateTrustLevel(state, userId)}`,
    "",
    "Wallet:",
    `Available: ${wallet.available} BDT`,
    `Withdrawable: ${wallet.withdrawable} BDT`,
    `Escrow: ${wallet.escrow} BDT`,
    "",
    "Activity:",
    `Approved jobs: ${approved}`,
    `Rejected jobs: ${rejected}`,
    `Disputes: ${disputes.length}`,
    `Buyer campaigns: ${campaigns.length}`,
    `Referrals: ${referrals.length}`
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

  return [
    "User Lookup",
    `ID: ${userId}`,
    `Name: ${user?.firstName ?? "Unknown"}`,
    `Username: ${user?.username ? `@${user.username}` : "N/A"}`,
    `Mode: ${user?.mode ?? "N/A"}`,
    `Trust: ${user?.trustLevel ?? "N/A"} (calculated: ${calculatedTrust})`,
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
  supportWaiters.delete(userId);
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

function formatReferralStats(userId: number, botUsername?: string): string {
  const referrals = store.snapshot().referrals.filter((referral) => referral.referrerId === userId);
  const credited = referrals.filter((referral) => referral.status === "credited");
  const earned = credited.reduce((sum, referral) => sum + referral.bonusAmount, 0);
  const link = botUsername ? `https://t.me/${botUsername}?start=ref_${userId}` : `https://t.me/YOUR_BOT_USERNAME?start=ref_${userId}`;

  return [
    "Neosence Referrals",
    `Your ID: ${userId}`,
    `Invites: ${referrals.length}`,
    `Credited: ${credited.length}`,
    `Referral earning: ${Math.round(earned * 100) / 100} BDT`,
    "",
    "Invite link:",
    link
  ].join("\n");
}

async function handleSupportMessage(ctx: Context & { from: TelegramFrom; message: unknown }) {
  const message = extractText(ctx.message);
  if (!message) {
    await ctx.reply("Support ticket-er jonno text message pathao.");
    return;
  }

  const ticket = createSupportTicket(ctx.from.id, message.slice(0, 1500));
  await store.addSupportTicket(ticket);
  supportWaiters.delete(ctx.from.id);
  await ctx.reply(`Support ticket created: ${ticket.id}`);
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
  taskDrafts.set(ctx.from.id, { step: "title" });
  await ctx.reply("Task title likho. Example: Join our Telegram channel", Markup.inlineKeyboard([
    [Markup.button.callback("Cancel", "wizard:cancel")]
  ]));
}

async function handleTaskWizardMessage(ctx: Context & { from: TelegramFrom; message: unknown }, draft: TaskDraft) {
  const text = extractText(ctx.message);
  if (!text) {
    await ctx.reply("Please text diye answer dao.");
    return;
  }

  if (draft.step === "title") {
    draft.title = text.slice(0, 80);
    draft.step = "category";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Category likho. Example: telegram, website, app, social, survey");
    return;
  }

  if (draft.step === "category") {
    draft.category = text.slice(0, 40).toLowerCase();
    draft.step = "approval";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Approval method choose koro:", Markup.inlineKeyboard([
      [Markup.button.callback("Manual Approval", "wizard:approval:manual")],
      [Markup.button.callback("Auto Verification", "wizard:approval:auto")],
      [Markup.button.callback("Cancel", "wizard:cancel")]
    ]));
    return;
  }

  if (draft.step === "reward") {
    const reward = Number(text);
    if (!Number.isFinite(reward) || reward <= 0) {
      await ctx.reply("Valid reward amount dao. Example: 5");
      return;
    }
    draft.rewardPerWorker = reward;
    draft.step = "workers";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Koto jon worker lagbe? Example: 100");
    return;
  }

  if (draft.step === "workers") {
    const workerLimit = Number(text);
    if (!Number.isInteger(workerLimit) || workerLimit <= 0) {
      await ctx.reply("Valid worker count dao. Example: 100");
      return;
    }
    draft.workerLimit = workerLimit;
    draft.step = "instructions";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Worker-er jonno clear instruction likho.");
    return;
  }

  if (draft.step === "instructions") {
    draft.instructions = text.slice(0, 1200);

    if (draft.approvalType === "auto") {
      draft.step = "verification";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply("Auto verification type choose koro:", Markup.inlineKeyboard([
        [Markup.button.callback("Telegram Join", "wizard:verification:telegram_join")],
        [Markup.button.callback("Website Visit", "wizard:verification:website_visit")],
        [Markup.button.callback("Website Webhook", "wizard:verification:website_webhook")],
        [Markup.button.callback("App Attribution", "wizard:verification:app_attribution")],
        [Markup.button.callback("In-App Code", "wizard:verification:in_app_code")],
        [Markup.button.callback("Quiz", "wizard:verification:quiz")],
        [Markup.button.callback("Cancel", "wizard:cancel")]
      ]));
      return;
    }

    draft.step = "confirm";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(formatDraftReview(draft), confirmTaskKeyboard());
    return;
  }

  if (draft.step === "target") {
    draft.verificationTarget = text.slice(0, 300);
    draft.step = "confirm";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(formatDraftReview(draft), confirmTaskKeyboard());
    return;
  }

  await ctx.reply("Ei step-er jonno button use koro, ba cancel korte Cancel press koro.");
}

function confirmTaskKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Publish Task", "wizard:confirm")],
    [Markup.button.callback("Cancel", "wizard:cancel")]
  ]);
}

function formatDraftReview(draft: TaskDraft): string {
  const rewardTotal = (draft.rewardPerWorker ?? 0) * (draft.workerLimit ?? 0);
  const fee = rewardTotal * (config.platformFeePercent / 100);
  return [
    "Review task before publishing:",
    "",
    `Title: ${draft.title}`,
    `Category: ${draft.category}`,
    `Approval: ${draft.approvalType}`,
    `Reward: ${draft.rewardPerWorker} BDT`,
    `Workers: ${draft.workerLimit}`,
    `Total escrow: ${Math.round((rewardTotal + fee) * 100) / 100} BDT`,
    draft.verificationType ? `Verification: ${draft.verificationType}` : undefined,
    draft.verificationTarget ? `Target: ${draft.verificationTarget}` : undefined,
    "",
    "Instructions:",
    draft.instructions
  ].filter(Boolean).join("\n");
}

function verificationTargetPrompt(type: VerificationType): string {
  if (type === "telegram_join") return "Target channel/group username or chat ID dao. Example: @yourchannel";
  if (type === "website_visit") return "Tracking target URL dao. Example: https://example.com";
  if (type === "website_webhook") return "Webhook/event name or target URL dao.";
  if (type === "app_attribution") return "App/package/deep link target dao.";
  if (type === "in_app_code") return "Verification code rule or target app info dao.";
  return "Correct quiz answer/code dao. Worker same answer dile auto reward pabe.";
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
  return Boolean(draft.verificationType && draft.verificationTarget);
}

function extractText(message: unknown): string | undefined {
  const textMessage = message as { text?: string };
  return textMessage.text?.trim();
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
      Markup.button.callback(`Pay ${shortId(withdrawal.id)} - ${withdrawal.amount} BDT`, `withdrawal:pay:${withdrawal.id}`),
      Markup.button.callback(`Reject ${shortId(withdrawal.id)}`, `withdrawal:reject:${withdrawal.id}`)
    ])
  ];

  if (rows.length === 0) {
    return Markup.inlineKeyboard([[Markup.button.callback("No pending review", "noop")]]);
  }

  return Markup.inlineKeyboard(rows);
}

function disputeListKeyboard(disputes: Dispute[]) {
  if (disputes.length === 0) {
    return Markup.inlineKeyboard([[Markup.button.callback("No open disputes", "noop")]]);
  }

  return Markup.inlineKeyboard(
    disputes.slice(0, 10).map((dispute) => [
      Markup.button.callback(`Pay ${shortId(dispute.id)}`, `dispute:pay:${dispute.id}`),
      Markup.button.callback(`Uphold ${shortId(dispute.id)}`, `dispute:uphold:${dispute.id}`)
    ])
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
    `Reward: ${submission.rewardAmount} BDT`,
    submission.rejectReason ? `Reject reason: ${submission.rejectReason}` : undefined,
    "",
    "Proof:",
    submission.proof ?? "No proof"
  ].filter(Boolean).join("\n");
}

async function approveSubmissionById(submissionId: string, reviewerId: number) {
  assertCanReviewSubmission(submissionId, reviewerId);
  const result = approveSubmission(store.snapshot(), submissionId);
  await store.updateSubmission(result.submission);
  await store.updateTask(result.task);
  await store.addTransaction(result.earnTransaction);
  await store.addTransaction(result.escrowReleaseTransaction);
  await refreshUserTrustLevel(result.submission.workerId);

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
  return submission;
}

function assertCanReviewSubmission(submissionId: string, reviewerId: number) {
  const state = store.snapshot();
  const submission = state.submissions.find((item) => item.id === submissionId);
  if (!submission) throw new Error("Submission not found");
  const task = state.tasks.find((item) => item.id === submission.taskId);
  if (!task) throw new Error("Task not found");
  if (task.buyerId !== reviewerId && !isAdmin(reviewerId)) {
    throw new Error("Ei submission review korar permission nei.");
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
  if (submission.workerId !== workerId) throw new Error("Ei submission-er worker apni na.");
  if (submission.status !== "rejected") throw new Error("Only rejected submissions can be disputed.");

  const task = state.tasks.find((item) => item.id === submission.taskId);
  if (!task) throw new Error("Task not found.");

  const alreadyOpen = state.disputes.some(
    (dispute) => dispute.submissionId === submission.id && dispute.status === "open"
  );
  if (alreadyOpen) throw new Error("Ei submission-er dispute already open ache.");

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

function campaignListKeyboard(tasks: Task[]) {
  return Markup.inlineKeyboard(
    tasks.slice(0, 10).map((task) => [
      Markup.button.callback(`${task.title} (${task.status})`, `campaign:view:${task.id}`)
    ])
  );
}

function campaignActionKeyboard(taskId: string, status: TaskStatus) {
  const rows = [];
  if (status === "active") {
    rows.push([Markup.button.callback("Pause", `campaign:pause:${taskId}`)]);
  }
  if (status === "paused") {
    rows.push([Markup.button.callback("Resume", `campaign:resume:${taskId}`)]);
  }
  if (status === "active" || status === "paused") {
    rows.push([Markup.button.callback("Cancel + Refund Unused", `campaign:cancel:${taskId}`)]);
  }
  rows.push([Markup.button.callback("Submissions", "menu:submissions")]);
  return Markup.inlineKeyboard(rows);
}

function formatCampaignList(tasks: Task[]): string {
  return [
    "My Campaigns",
    "",
    ...tasks.slice(0, 10).map((task) => {
      const pending = store.snapshot().submissions.filter((submission) => submission.taskId === task.id && submission.status === "pending").length;
      return `- ${task.title}: ${task.status}, ${task.completedCount}/${task.workerLimit}, pending ${pending}`;
    })
  ].join("\n");
}

function formatCampaignDetail(taskId: string): string {
  const state = store.snapshot();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return "Campaign not found.";
  const submissions = state.submissions.filter((submission) => submission.taskId === task.id);
  const pending = submissions.filter((submission) => submission.status === "pending").length;
  const approved = submissions.filter((submission) => submission.status === "approved" || submission.status === "auto_approved").length;
  const rejected = submissions.filter((submission) => submission.status === "rejected").length;

  return [
    formatTask(task),
    "",
    "Campaign stats:",
    `Pending proof: ${pending}`,
    `Approved/auto: ${approved}`,
    `Rejected: ${rejected}`,
    `Outstanding escrow: ${campaignOutstandingEscrow(task.id)} BDT`
  ].join("\n");
}

function getReviewableTask(taskId: string, userId: number): Task {
  const task = store.snapshot().tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("Campaign not found.");
  if (task.buyerId !== userId && !isAdmin(userId)) {
    throw new Error("Ei campaign manage korar permission nei.");
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
    throw new Error("Cancel korar age pending submissions approve/reject koro.");
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

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  const requestUrl = new URL(request.url ?? "/", publicBaseUrl());

  if (requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, ...runtime }));
    return;
  }

  if (requestUrl.pathname === "/track/visit") {
    await handleWebsiteVisitTrack(request, response, requestUrl);
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

  const alreadyPassed = state.verificationEvents.some(
    (event) => event.taskId === taskId && event.workerId === workerId && event.type === "website_visit" && event.status === "passed"
  );

  if (!alreadyPassed) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId,
      workerId,
      type: "website_visit",
      status: "passed",
      metadata: {
        ip: request.headers["x-forwarded-for"] ?? request.socket.remoteAddress,
        userAgent: request.headers["user-agent"] ?? "unknown"
      }
    }));
  }

  if (task.verificationTarget?.startsWith("http://") || task.verificationTarget?.startsWith("https://")) {
    response.writeHead(302, { location: task.verificationTarget });
    response.end();
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Visit tracked. Return to Telegram and press Verify Now.");
}

function publicBaseUrl(): string {
  if (config.publicUrl) return config.publicUrl;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${config.port}`;
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
    const member = await ctx.telegram.getChatMember(task.verificationTarget, ctx.from.id);
    const passed = ["member", "administrator", "creator"].includes(member.status);
    if (!passed) {
      await ctx.reply("Membership verify hoyni. Join kore abar Verify Now press koro.");
      return;
    }

    const submission = createSubmission(task, ctx.from.id, "telegram_join_verified");
    const updatedTask = {
      ...task,
      completedCount: task.completedCount + 1,
      status: task.completedCount + 1 >= task.workerLimit ? "completed" as const : task.status,
      updatedAt: new Date().toISOString()
    };
    await store.addSubmission(submission);
    await store.updateTask(updatedTask);
    await store.addTransaction(createTransaction({
      userId: ctx.from.id,
      type: "earn",
      amount: task.rewardPerWorker,
      taskId: task.id,
      submissionId: submission.id,
      note: `Auto verified. Withdraw hold target: ${config.autoWithdrawHoldHours}h`
    }));
    await store.addTransaction(createTransaction({
      userId: task.buyerId,
      type: "escrow_release",
      amount: task.rewardPerWorker,
      taskId: task.id,
      submissionId: submission.id
    }));
    await ctx.reply(`Verified. ${task.rewardPerWorker} BDT added to your wallet.`);
  } catch (error) {
    await ctx.reply(`Verification failed. Bot ke target channel/group-e add kora ache kina check koro. ${(error as Error).message}`);
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
      "Website visit ekhono track hoyni.",
      "Ei link open koro, tarpor Telegram-e fire Verify Now abar press koro:",
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
    await ctx.reply("Text answer pathao.");
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
    await ctx.reply("Answer match koreni. Instruction check kore abar Verify Now press koro.");
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

async function completeAutoTask(task: Task, workerId: number, proof: string, note: string) {
  const alreadySubmitted = store.snapshot().submissions.some(
    (submission) => submission.taskId === task.id && submission.workerId === workerId
  );
  if (alreadySubmitted) throw new Error("You already submitted this task.");

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
  console.error("Bot error", error);
});

await bot.launch();
console.log("Neosence Bot is running");
console.log(config.databaseUrl ? "Storage: PostgreSQL" : "Storage: local JSON fallback");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
