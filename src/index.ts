import { createServer } from "node:http";
import { Context, Telegraf } from "telegraf";
import { config, isAdmin } from "./config.js";
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
import type { TaskApprovalType, VerificationType } from "./types.js";

const store = createStore({ databaseUrl: config.databaseUrl, dataFile: config.dataFile });
await store.load();

const bot = new Telegraf(config.botToken);
const proofWaiters = new Map<number, string>();

bot.start(async (ctx) => {
  const user = await ensureUser(ctx.from);
  await ctx.reply(
    `Welcome to Neosence Bot.\n\nEarn from verified micro tasks or post work for real users. Current mode: ${user.mode}.`,
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
  const text = ctx.message.text.replace("/posttask", "").trim();

  if (!text) {
    await ctx.reply([
      "Create task format:",
      "/posttask title | category | manual/auto | reward | workers | instructions | verification_type(optional) | target(optional)",
      "",
      "Example manual:",
      "/posttask Review our site | website | manual | 5 | 20 | Visit site and submit screenshot",
      "",
      "Example auto Telegram:",
      "/posttask Join channel | telegram | auto | 2 | 100 | Join and press verify | telegram_join | @yourchannel"
    ].join("\n"));
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
  await ctx.reply([
    "Neosence Admin",
    `Users: ${state.users.length}`,
    `Tasks: ${state.tasks.length}`,
    `Pending submissions: ${state.submissions.filter((item) => item.status === "pending").length}`,
    `Pending withdrawals: ${state.withdrawals.filter((item) => item.status === "pending").length}`,
    "",
    "Commands:",
    "/deposit <userId> <amount> <note>",
    "/approve <submissionId>",
    "/reject <submissionId> <reason>",
    "/paywithdraw <withdrawalId>",
    "/rejectwithdraw <withdrawalId> <reason>"
  ].join("\n"));
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
    const result = approveSubmission(store.snapshot(), submissionId);
    await store.updateSubmission(result.submission);
    await store.updateTask(result.task);
    await store.addTransaction(result.earnTransaction);
    await store.addTransaction(result.escrowReleaseTransaction);
    await ctx.reply(`Approved ${submissionId}. Worker earned ${result.submission.rewardAmount} BDT.`);
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
    const submission = rejectSubmission(store.snapshot(), submissionId, reason);
    await store.updateSubmission(submission);
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

  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) {
    await ctx.reply("Withdrawal not found.");
    return;
  }
  if (withdrawal.status !== "pending") {
    await ctx.reply(`Withdrawal already ${withdrawal.status}.`);
    return;
  }

  await store.updateWithdrawal({
    ...withdrawal,
    status: "paid",
    reviewedAt: new Date().toISOString()
  });
  await store.addTransaction(createTransaction({
    userId: withdrawal.userId,
    type: "withdraw_paid",
    amount: withdrawal.amount,
    note: withdrawal.method
  }));
  await ctx.reply(`Withdrawal paid: ${withdrawal.id}`);
});

bot.command("rejectwithdraw", async (ctx) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) return;
  const [, withdrawalId, ...reasonParts] = ctx.message.text.split(" ");
  const reason = reasonParts.join(" ").trim();
  if (!withdrawalId || !reason) {
    await ctx.reply("Format: /rejectwithdraw <withdrawalId> <reason>");
    return;
  }

  const withdrawal = store.snapshot().withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) {
    await ctx.reply("Withdrawal not found.");
    return;
  }
  if (withdrawal.status !== "pending") {
    await ctx.reply(`Withdrawal already ${withdrawal.status}.`);
    return;
  }

  await store.updateWithdrawal({
    ...withdrawal,
    status: "rejected",
    reviewedAt: new Date().toISOString()
  });
  await store.addTransaction(createTransaction({
    userId: withdrawal.userId,
    type: "withdraw_rejected",
    amount: withdrawal.amount,
    note: reason
  }));
  await ctx.reply(`Withdrawal rejected: ${withdrawal.id}`);
});

bot.action("menu:earn", async (ctx) => {
  await ctx.answerCbQuery();
  await ensureUser(ctx.from);
  await showEarn(ctx);
});

bot.action("menu:post", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Use /posttask to create a task. Example format dekhte sudhu /posttask pathao.");
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

bot.action("menu:mytasks", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Use /mytasks to see your buyer tasks and freelancer submissions.");
});

bot.action("menu:support", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Support MVP: contact admin. Later ekhane ticket system add hobe.");
});

bot.action(/^mode:(freelancer|buyer)$/, async (ctx) => {
  const mode = ctx.match[1] as "freelancer" | "buyer";
  const user = await ensureUser(ctx.from);
  await store.upsertUser(switchMode(user, mode));
  await ctx.answerCbQuery(`Mode changed to ${mode}`);
  await ctx.reply(`Neosence mode changed: ${mode}`);
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

createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "neosence-bot" }));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Neosence Bot is running");
}).listen(config.port, () => {
  console.log(`Health server listening on ${config.port}`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
