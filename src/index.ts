import { createServer } from "node:http";
import { Context, Markup, Telegraf } from "telegraf";
import { config, isAdmin } from "./config.js";
import { runtime } from "./runtime.js";
import { createStore } from "./store.js";
import {
  approveSubmission,
  createSubmission,
  createTask,
  createTransaction,
  createWithdrawal,
  escrowRequired,
  getOrCreateUser,
  rejectSubmission,
  switchMode,
  visibleTasks,
  walletSummary
} from "./services.js";
import { formatTask, mainMenu, modeMenu, taskActionButtons, taskButtons } from "./ui.js";
import type { Submission, TaskApprovalType, VerificationType, Withdrawal } from "./types.js";

const store = createStore({ databaseUrl: config.databaseUrl, dataFile: config.dataFile });

createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, ...runtime }));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Neosence Bot is running");
}).listen(config.port, () => {
  console.log(`Health server listening on ${config.port}`);
});

await store.load();

const bot = new Telegraf(config.botToken);
const proofWaiters = new Map<number, string>();
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

bot.start(async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(
    `Welcome to Neosence Bot.\n\nCurrent workspace: ${formatMode(user.mode)}.`,
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
  await ctx.reply(formatWallet(user.id));
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

bot.command("admin", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const state = store.snapshot();
  const pendingSubmissions = state.submissions.filter((item) => item.status === "pending");
  const pendingWithdrawals = state.withdrawals.filter((item) => item.status === "pending");
  await ctx.reply([
    "Neosence Admin",
    `Users: ${state.users.length}`,
    `Tasks: ${state.tasks.length}`,
    `Pending submissions: ${pendingSubmissions.length}`,
    `Pending withdrawals: ${pendingWithdrawals.length}`,
    "",
    "Use buttons below for quick review.",
    "",
    "Commands:",
    "/deposit <userId> <amount> <note>",
    "/approve <submissionId>",
    "/reject <submissionId> <reason>",
    "/paywithdraw <withdrawalId>",
    "/rejectwithdraw <withdrawalId> <reason>"
  ].join("\n"), adminReviewKeyboard(pendingSubmissions, pendingWithdrawals));
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
  await ensureUser(ctx.from);
  await ctx.reply(formatWallet(ctx.from.id));
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
  await ctx.reply("Use /mytasks to see your buyer campaigns.");
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
  await ctx.reply("Withdraw request format: /withdraw 100 bkash:01XXXXXXXXX");
});

bot.action("menu:referrals", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Referral system next milestone-e add hobe. Ekhon task marketplace core flow test kora hocche.");
});

bot.action("menu:support", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Support MVP: contact admin. Later ekhane ticket system add hobe.");
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

  await ctx.reply("Ei auto verification integration ekhono connected na. MVP te telegram_join ready, website/app webhook layer next step.");
});

bot.on("message", async (ctx, next) => {
  if (!ctx.from) return next();
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

function formatWallet(userId: number): string {
  const wallet = walletSummary(store.snapshot(), userId);
  return [
    "Neosence Wallet",
    `Available: ${wallet.available} BDT`,
    `Pending: ${wallet.pending} BDT`,
    `Withdrawable: ${wallet.withdrawable} BDT`,
    `Escrow locked: ${wallet.escrow} BDT`
  ].join("\n");
}

function formatMode(mode: "freelancer" | "buyer"): string {
  return mode === "freelancer" ? "Freelancer Mode" : "Buyer Mode";
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
  return "Quiz identifier or question set name dao.";
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

function adminReviewKeyboard(submissions: Submission[], withdrawals: Withdrawal[]) {
  const rows = [
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

  return {
    workerId: result.submission.workerId,
    rewardAmount: result.submission.rewardAmount
  };
}

async function rejectSubmissionById(submissionId: string, reason: string, reviewerId: number) {
  assertCanReviewSubmission(submissionId, reviewerId);
  const submission = rejectSubmission(store.snapshot(), submissionId, reason);
  await store.updateSubmission(submission);
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

function extractProof(message: unknown): string {
  const proofMessage = message as { text?: string; caption?: string; photo?: unknown[]; document?: { file_id: string } };
  if (proofMessage.text) return proofMessage.text;
  if (proofMessage.caption) return proofMessage.caption;
  if (proofMessage.photo?.length) return "photo_proof";
  if (proofMessage.document?.file_id) return `document:${proofMessage.document.file_id}`;
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
