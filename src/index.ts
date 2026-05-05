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
import { formatTask, mainMenu, modeMenu, taskActionButtons } from "./ui.js";
import { t } from "./messages.js";
import type { DepositRequest, Dispute, Submission, Task, TaskApprovalType, TaskStatus, TrackedChat, VerificationType, Withdrawal } from "./types.js";

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
const DRAFT_TTL_MS = 60 * 60 * 1000;
const VERIFY_COOLDOWN_MS = 15 * 1000;
const verifyCooldowns = new Map<string, number>();

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
      t.start.welcome,
      "",
      `Current workspace: ${formatMode(user.mode)}.`,
      referralMessage
    ].filter(Boolean).join("\n"),
    mainMenu(user)
  );
});

bot.command("mode", async (ctx) => {
  await ensureUser(ctx.from);
  await ctx.reply(t.start.chooseMode, modeMenu());
});

bot.command("language", async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatLanguageStatus(user.language), languageKeyboard());
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

bot.command("cancel", async (ctx) => {
  await ensureUser(ctx.from);
  taskDrafts.delete(ctx.from.id);
  proofWaiters.delete(ctx.from.id);
  quizWaiters.delete(ctx.from.id);
  supportWaiters.delete(ctx.from.id);
  await ctx.reply("Current draft/input cancelled.");
});

bot.command("posttask", async (ctx) => {
  const user = await ensureUser(ctx.from);
  if (user.mode !== "buyer") {
    await ctx.reply(t.common.switchToBuyer, mainMenu(user));
    return;
  }

  const text = ctx.message.text.replace("/posttask", "").trim();

  if (!text) {
    await startTaskWizard(ctx);
    return;
  }

  const parts = text.split("|").map((item) => item.trim());
  if (parts.length < 6) {
    await ctx.reply("This command needs at least 6 fields. Send /posttask with no text to use the guided wizard.");
    return;
  }

  const [title, category, approvalRaw, rewardRaw, workersRaw, instructions, verificationRaw, target] = parts;
  const approvalType = approvalRaw as TaskApprovalType;
  const rewardPerWorker = Number(rewardRaw);
  const workerLimit = Number(workersRaw);

  if (!["manual", "auto"].includes(approvalType) || !Number.isFinite(rewardPerWorker) || !Number.isInteger(workerLimit)) {
    await ctx.reply("Approval must be manual/auto. Reward must be a number and workers must be a whole number.");
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
    verificationTarget: target,
    websiteVisitSeconds: verificationRaw === "website_visit" ? 30 : undefined
  });
  try {
    assertCampaignTargetAllowed(task);
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

  await ctx.reply(`✅ Task published\n\n${formatTask(task)}\n\nEscrow locked: ${escrowRequired(task)} BDT`);
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

bot.action(/^earn:category:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  await showEarnCategory(ctx, ctx.match[1], Number(ctx.match[2]));
});

bot.action("earn:categories", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.action("menu:post", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  if (user.mode !== "buyer") {
    await ctx.reply(t.common.switchToBuyer, mainMenu(user));
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
  const userMessages = t.language;
  await ctx.reply(
    language === "en"
      ? userMessages.englishSet
      : userMessages.banglaSet,
    mainMenu(updatedUser)
  );
});

bot.action("menu:jobs", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("📌 Use /mytasks to see your accepted jobs and submissions.");
});

bot.action("menu:campaigns", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  const tasks = store.snapshot().tasks.filter((task) => task.buyerId === user.id);
  if (tasks.length === 0) {
    await ctx.reply("No campaigns yet. Use Post Task to create your first campaign.", mainMenu(user));
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
    await ctx.reply("No campaign submissions yet.");
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

bot.action("menu:language", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx.from);
  await ctx.reply(formatLanguageStatus(user.language), languageKeyboard());
});

bot.action("menu:support", async (ctx) => {
  await ctx.answerCbQuery();
  supportWaiters.add(ctx.from.id);
  await ctx.reply(t.support.prompt);
});

bot.action("noop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.on("my_chat_member", async (ctx) => {
  const update = ctx.myChatMember;
  const chat = update.chat;
  const status = update.new_chat_member.status;
  const trackedChat: TrackedChat = {
    id: chat.id,
    title: "title" in chat ? chat.title : undefined,
    type: chat.type as TrackedChat["type"],
    botStatus: status,
    canVerifyMembers: status === "administrator" || status === "creator",
    updatedAt: new Date().toISOString()
  };
  await store.upsertTrackedChat(trackedChat);
  await notifyWaitingDraftsForChat(trackedChat);
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
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(t.common.draftExpired);
    return;
  }

  draft.approvalType = ctx.match[1] as TaskApprovalType;
  draft.step = "reward";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(t.taskWizard.enterReward);
});

bot.action(/^wizard:type:(telegram_join|website_visit|quiz|manual_proof|app_task|custom)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(t.common.draftExpired);
    return;
  }

  applyTaskTypeTemplate(draft, ctx.match[1]);
  taskDrafts.set(ctx.from.id, draft);

  if (draft.verificationType) {
    await ctx.reply(verificationTargetPrompt(draft.verificationType));
    return;
  }

  await ctx.reply("Task title likho.");
});

bot.action(/^wizard:category:(telegram|website|app|social|survey|data_entry|review|quiz|custom)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply("Task draft expired. /posttask diye abar shuru koro.");
    return;
  }

  draft.category = ctx.match[1];
  draft.title = defaultTitleForCategory(draft.category);
  draft.instructions = defaultInstructionForCategory(draft.category);
  draft.step = "task_type";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(t.taskWizard.chooseVerification, verificationMethodKeyboard(draft.category));
});

bot.action(/^wizard:method:(auto_join|timer_visit|quiz_answer|manual_proof|webhook|app_tracking|in_app_code)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = getTaskDraft(ctx.from.id);
  if (!draft?.category) {
    await ctx.reply(t.common.draftExpired);
    return;
  }

  applyVerificationMethod(draft, ctx.match[1]);
  taskDrafts.set(ctx.from.id, draft);

  if (draft.verificationType) {
    await ctx.reply(verificationTargetPrompt(draft.verificationType));
    return;
  }

  await ctx.reply(t.taskWizard.enterTitle);
});

bot.action("wizard:instruction:skip", async (ctx) => {
  await ctx.answerCbQuery();
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(t.common.draftExpired);
    return;
  }
  draft.step = "confirm";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(formatDraftReview(draft), confirmTaskKeyboard());
});

bot.action("wizard:instruction:edit", async (ctx) => {
  await ctx.answerCbQuery();
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(t.common.draftExpired);
    return;
  }
  draft.step = "instructions";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(t.taskWizard.editInstruction);
});

bot.action(/^wizard:verification:(telegram_join|website_visit|website_webhook|app_attribution|in_app_code|quiz)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = getTaskDraft(ctx.from.id);
  if (!draft) {
    await ctx.reply(t.common.draftExpired);
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
  const draft = getTaskDraft(ctx.from.id);
  if (!draft || !isCompleteDraft(draft)) {
    await ctx.reply("This draft is incomplete. Start again with /posttask.");
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
    verificationTarget: draft.verificationTarget,
    websiteVisitSeconds: draft.websiteVisitSeconds
  });
  try {
    assertCampaignTargetAllowed(task);
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

  await ctx.reply(`${t.taskWizard.published}\n\n${formatTask(task)}\n\nEscrow locked: ${escrowRequired(task)} BDT`, mainMenu(user));
});

bot.action("wizard:cancel", async (ctx) => {
  await ctx.answerCbQuery();
  taskDrafts.delete(ctx.from.id);
  const user = await ensureUser(ctx.from);
  await ctx.reply(t.taskWizard.cancelled, mainMenu(user));
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
  const cooldownKey = `${ctx.from.id}:${ctx.match[1]}`;
  const lastVerifyAt = verifyCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastVerifyAt < VERIFY_COOLDOWN_MS) {
    await ctx.reply("Ektu wait koro, Verify Now abar try korte 15 seconds gap lagbe.");
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

  const draft = getTaskDraft(ctx.from.id);
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
  const tasks = visibleTasks(store.snapshot(), userId);
  if (tasks.length === 0) {
    await ctx.reply(t.common.noTasksAvailable);
    return;
  }
  await ctx.reply(t.earn.chooseCategory, earnCategoryKeyboard(tasks));
}

async function showEarnCategory(ctx: Context & { from: TelegramFrom }, category: string, page: number) {
  const allTasks = visibleTasks(store.snapshot(), ctx.from.id);
  const filtered = category === "all" ? allTasks : allTasks.filter((task) => task.category === category);
  if (filtered.length === 0) {
    await ctx.reply(t.earn.noCategoryTasks, Markup.inlineKeyboard([
      [Markup.button.callback(t.earn.backToCategories, "earn:categories")]
    ]));
    return;
  }

  const pageSize = 8;
  const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const tasks = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);
  await ctx.reply(
    `💼 ${categoryLabel(category)} Tasks\nPage ${safePage + 1}/${totalPages}`,
    earnTaskListKeyboard(tasks, category, safePage, totalPages)
  );
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
      "💰 Buyer Balance",
      ...common,
      "",
      "Deposit",
      "Send payment to admin/payment number, then submit request:",
      "/depositreq 500 bkash trxid-or-proof-note"
    ].join("\n");
  }

  return [
    "💰 Freelancer Wallet",
    ...common,
    "",
    "Withdraw",
    "/withdraw 100 bkash:01XXXXXXXXX"
  ].join("\n");
}

function formatMode(mode: "freelancer" | "buyer"): string {
  return mode === "freelancer" ? "Freelancer Mode" : "Buyer Mode";
}

const earnCategories = ["telegram", "website", "app", "social", "survey", "data_entry", "review", "quiz", "custom"];

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    all: "All",
    telegram: "Telegram",
    website: "Website",
    app: "App",
    social: "Social",
    survey: "Survey",
    data_entry: "Data Entry",
    review: "Review",
    quiz: "Quiz / Code",
    custom: "Custom"
  };
  return labels[category] ?? category;
}

function earnCategoryKeyboard(tasks: Task[]) {
  const rows = earnCategories
    .map((category) => {
      const count = tasks.filter((task) => task.category === category).length;
      return count > 0 ? [Markup.button.callback(`${categoryLabel(category)} (${count})`, `earn:category:${category}:0`)] : undefined;
    })
    .filter((row): row is Array<ReturnType<typeof Markup.button.callback>> => Boolean(row));
  rows.push([Markup.button.callback(`All Tasks (${tasks.length})`, "earn:category:all:0")]);
  return Markup.inlineKeyboard(rows);
}

function earnTaskListKeyboard(tasks: Task[], category: string, page: number, totalPages: number) {
  const rows = tasks.map((task) => [
    Markup.button.callback(`${task.title} - ${task.rewardPerWorker} BDT`, `task:${task.id}`)
  ]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("Previous", `earn:category:${category}:${page - 1}`));
  if (page + 1 < totalPages) nav.push(Markup.button.callback("Next", `earn:category:${category}:${page + 1}`));
  if (nav.length > 0) rows.push(nav);
  rows.push([Markup.button.callback(t.earn.backToCategories, "earn:categories")]);
  return Markup.inlineKeyboard(rows);
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
    "👤 Neosence Profile",
    `User ID: ${userId}`,
    `Name: ${user?.firstName ?? "Unknown"}`,
    `Username: ${user?.username ? `@${user.username}` : "N/A"}`,
    `Mode: ${user?.mode ?? "N/A"}`,
    `Language: ${user?.language ?? "en"}`,
    `Trust: ${user?.trustLevel ?? calculateTrustLevel(state, userId)}`,
    "",
    "Wallet",
    `Available: ${wallet.available} BDT`,
    `Withdrawable: ${wallet.withdrawable} BDT`,
    `Escrow: ${wallet.escrow} BDT`,
    "",
    "Activity",
    `Approved jobs: ${approved}`,
    `Rejected jobs: ${rejected}`,
    `Disputes: ${disputes.length}`,
    `Buyer campaigns: ${campaigns.length}`,
    `Referrals: ${referrals.length}`
  ].join("\n");
}

function languageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("English", "language:en")],
    [Markup.button.callback("Bangla", "language:bn")]
  ]);
}

function formatLanguageStatus(language: "en" | "bn") {
  const languageMessages = t.language;
  const label = language === "bn" ? "Bangla" : "English";
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
  setTaskDraft(ctx.from.id, { step: "task_type" });
  await ctx.reply(t.taskWizard.chooseCategory, Markup.inlineKeyboard([
    [Markup.button.callback("📢 Telegram", "wizard:category:telegram"), Markup.button.callback("🌐 Website", "wizard:category:website")],
    [Markup.button.callback("📱 App", "wizard:category:app"), Markup.button.callback("📣 Social", "wizard:category:social")],
    [Markup.button.callback("📝 Survey", "wizard:category:survey"), Markup.button.callback("⌨️ Data Entry", "wizard:category:data_entry")],
    [Markup.button.callback("⭐ Review", "wizard:category:review"), Markup.button.callback("✅ Quiz / Code", "wizard:category:quiz")],
    [Markup.button.callback("⚙️ Custom", "wizard:category:custom")],
    [Markup.button.callback(t.common.cancel, "wizard:cancel")]
  ]));
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

function verificationMethodKeyboard(category: string) {
  const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
  if (category === "telegram") {
    rows.push([Markup.button.callback("Auto Join", "wizard:method:auto_join")]);
    rows.push([Markup.button.callback("Manual Proof", "wizard:method:manual_proof")]);
  } else if (category === "website") {
    rows.push([Markup.button.callback("Timer Visit", "wizard:method:timer_visit")]);
    rows.push([Markup.button.callback("Manual Proof", "wizard:method:manual_proof")]);
    rows.push([Markup.button.callback("Webhook/API", "wizard:method:webhook")]);
  } else if (category === "app") {
    rows.push([Markup.button.callback("Manual Proof", "wizard:method:manual_proof")]);
    rows.push([Markup.button.callback("App Tracking", "wizard:method:app_tracking")]);
    rows.push([Markup.button.callback("In-App Code", "wizard:method:in_app_code")]);
  } else if (category === "quiz") {
    rows.push([Markup.button.callback("Auto Answer", "wizard:method:quiz_answer")]);
    rows.push([Markup.button.callback("Manual Proof", "wizard:method:manual_proof")]);
  } else {
    rows.push([Markup.button.callback("Manual Proof", "wizard:method:manual_proof")]);
  }
  rows.push([Markup.button.callback("Cancel", "wizard:cancel")]);
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
    draft.step = "target";
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
  draft.step = "title";
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

async function handleTaskWizardMessage(ctx: Context & { from: TelegramFrom; message: unknown }, draft: TaskDraft) {
  const text = extractText(ctx.message);
  if (!text) {
    await ctx.reply("Please send a text answer.");
    return;
  }

  if (draft.step === "title") {
    draft.title = text.slice(0, 80);
    if (draft.category && draft.approvalType) {
      draft.step = "instructions";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply("Write the instruction, or send /skip to use the template.");
      return;
    }

    draft.step = "category";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Enter a category. Example: telegram, website, app, social, survey");
    return;
  }

  if (draft.step === "category") {
    draft.category = text.slice(0, 40).toLowerCase();
    draft.step = "approval";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Choose an approval method:", Markup.inlineKeyboard([
      [Markup.button.callback("Manual Approval", "wizard:approval:manual")],
      [Markup.button.callback("Auto Verification", "wizard:approval:auto")],
      [Markup.button.callback("Cancel", "wizard:cancel")]
    ]));
    return;
  }

  if (draft.step === "reward") {
    const reward = Number(text);
    if (!Number.isFinite(reward) || reward <= 0) {
      await ctx.reply("Enter a valid reward amount. Example: 5");
      return;
    }
    draft.rewardPerWorker = reward;
    draft.step = "workers";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(t.taskWizard.enterWorkers);
    return;
  }

  if (draft.step === "workers") {
    const workerLimit = Number(text);
    if (!Number.isInteger(workerLimit) || workerLimit <= 0) {
      await ctx.reply("Enter a valid worker count. Example: 100");
      return;
    }
    draft.workerLimit = workerLimit;
    if (draft.instructions) {
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply([
        t.taskWizard.templateReadyTitle,
        "",
        draft.instructions,
        "",
        t.taskWizard.templateChoice
      ].join("\n"), Markup.inlineKeyboard([
        [Markup.button.callback("Use Template", "wizard:instruction:skip")],
        [Markup.button.callback("Edit Instruction", "wizard:instruction:edit")],
        [Markup.button.callback("Cancel", "wizard:cancel")]
      ]));
      return;
    }

    draft.step = "instructions";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(t.taskWizard.enterInstruction);
    return;
  }

  if (draft.step === "instructions") {
    if (text.toLowerCase() !== "/skip") {
      draft.instructions = text.slice(0, 1200);
    }

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

    if (!draft.rewardPerWorker) {
      draft.step = "reward";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply("Reward per worker koto BDT? Example: 5");
      return;
    }

    if (!draft.workerLimit) {
      draft.step = "workers";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply("Koto jon worker lagbe? Example: 100");
      return;
    }

    draft.step = "confirm";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply(formatDraftReview(draft), confirmTaskKeyboard());
    return;
  }

  if (draft.step === "target") {
    if (draft.verificationType === "telegram_join") {
      const chatId = Number(text);
      if (!Number.isFinite(chatId)) {
      await ctx.reply("Enter the numeric channel/group chat ID.\n\nExample: -1001234567890");
        return;
      }

      const trackedChat = store.snapshot().trackedChats.find((chat) => chat.id === chatId);
      if (!trackedChat?.canVerifyMembers) {
        draft.verificationTarget = String(chatId);
        taskDrafts.set(ctx.from.id, draft);
        await ctx.reply([
        "I cannot access this chat yet.",
        "Add this bot as an admin in the target channel/group. I will detect it automatically.",
          `Waiting chat ID: ${chatId}`,
        "After adding the bot, send the same ID again to continue."
        ].join("\n"));
        return;
      }
      draft.verificationTarget = String(chatId);
    } else {
      draft.verificationTarget = text.slice(0, 300);
    }

    if (draft.verificationType === "website_visit") {
      draft.step = "website_timer";
      taskDrafts.set(ctx.from.id, draft);
      await ctx.reply("Enter visit timer in seconds.\n\nExamples: 30, 60, 120");
      return;
    }

    await promptNextCommercialStep(ctx, draft);
    return;
  }

  if (draft.step === "website_timer") {
    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) {
      await ctx.reply("Enter a valid timer between 5 and 600 seconds.");
      return;
    }
    draft.websiteVisitSeconds = seconds;
    await promptNextCommercialStep(ctx, draft);
    return;
  }

  await ctx.reply("Use the buttons for this step, or press Cancel.");
}

function confirmTaskKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Publish Task", "wizard:confirm")],
    [Markup.button.callback("Cancel", "wizard:cancel")]
  ]);
}

async function promptNextCommercialStep(ctx: Context & { from: TelegramFrom }, draft: TaskDraft) {
  if (!draft.rewardPerWorker) {
    draft.step = "reward";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Reward per worker koto BDT? Example: 5");
    return;
  }

  if (!draft.workerLimit) {
    draft.step = "workers";
    taskDrafts.set(ctx.from.id, draft);
    await ctx.reply("Koto jon worker lagbe? Example: 100");
    return;
  }

  draft.step = "confirm";
  taskDrafts.set(ctx.from.id, draft);
  await ctx.reply(formatDraftReview(draft), confirmTaskKeyboard());
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
    draft.websiteVisitSeconds ? `Visit timer: ${draft.websiteVisitSeconds}s` : undefined,
    "",
    "Instructions:",
    draft.instructions
  ].filter(Boolean).join("\n");
}

function verificationTargetPrompt(type: VerificationType): string {
  if (type === "telegram_join") return [
    "Target channel/group numeric chat ID dao.",
    "Bot-ke oi channel/group-er admin banate hobe.",
    "Bot admin hole backend automatically added list-e save korbe.",
    "Example: -1001234567890"
  ].join("\n");
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
  if (!draft.verificationType || !draft.verificationTarget) return false;
  if (draft.verificationType === "website_visit") return Boolean(draft.websiteVisitSeconds);
  return true;
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

function assertCampaignTargetAllowed(newTask: Task) {
  if (!newTask.verificationTarget) return;
  const duplicate = store.snapshot().tasks.find((task) =>
    task.buyerId === newTask.buyerId &&
    task.status === "active" &&
    task.verificationType === newTask.verificationType &&
    task.verificationTarget === newTask.verificationTarget
  );
  if (duplicate) {
    throw new Error(`Same target-e active campaign already ache: ${duplicate.title}`);
  }
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

  if (requestUrl.pathname === "/track/complete") {
    await handleWebsiteVisitComplete(response, requestUrl);
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
  const completeUrl = new URL("/track/complete", publicBaseUrl());
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
  const task = store.snapshot().tasks.find((item) => item.id === taskId);

  if (!task || task.verificationType !== "website_visit" || !Number.isFinite(workerId)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "invalid_tracking_request" }));
    return;
  }

  const alreadySubmitted = store.snapshot().submissions.some(
    (submission) => submission.taskId === task.id && submission.workerId === workerId
  );

  if (!alreadySubmitted) {
    await store.addVerificationEvent(createVerificationEvent({
      taskId,
      workerId,
      type: "website_visit",
      status: "passed",
      metadata: {
        ip: requestUrl.searchParams.get("ip") ?? "unknown",
        userAgent: requestUrl.searchParams.get("ua") ?? "unknown",
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
    const chatId = Number(task.verificationTarget);
    const trackedChat = store.snapshot().trackedChats.find((chat) => chat.id === chatId);
    if (!trackedChat?.canVerifyMembers) {
      await ctx.reply("Bot ekhono ei channel/group-er admin access pache na. Buyer-ke bot admin korte bolo.");
      return;
    }
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
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
