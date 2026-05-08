import { Markup } from "telegraf";
import type { Task, UserProfile } from "./types.js";
import { getMessages } from "./messages.js";
import type { LanguageCode } from "./messages.js";

export function mainMenu(user: UserProfile) {
  const t = getMessages(user.language);
  if (user.mode === "buyer") {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t.menu.postTask, "menu:post")],
      [Markup.button.callback(t.menu.campaigns, "menu:campaigns"), Markup.button.callback(t.menu.submissions, "menu:submissions")],
      [Markup.button.callback(t.menu.balance, "menu:wallet"), Markup.button.callback(t.menu.freelancerMode, "mode:freelancer")],
      [Markup.button.callback(t.menu.profile, "menu:profile"), Markup.button.callback(t.menu.language, "menu:language")],
      [Markup.button.callback(t.menu.support, "menu:support")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(t.menu.earnMoney, "menu:earn")],
    [Markup.button.callback(t.menu.myJobs, "menu:jobs"), Markup.button.callback(t.menu.wallet, "menu:wallet")],
    [Markup.button.callback(t.menu.withdraw, "menu:withdraw"), Markup.button.callback(t.menu.buyerMode, "mode:buyer")],
    [Markup.button.callback(t.menu.referrals, "menu:referrals"), Markup.button.callback(t.menu.profile, "menu:profile")],
    [Markup.button.callback(t.menu.language, "menu:language")],
    [Markup.button.callback(t.menu.support, "menu:support")]
  ]);
}

export function modeMenu(language?: LanguageCode) {
  const t = getMessages(language);
  return Markup.inlineKeyboard([
    [Markup.button.callback(t.menu.workAsFreelancer, "mode:freelancer")],
    [Markup.button.callback(t.menu.hireAsBuyer, "mode:buyer")]
  ]);
}

export function taskButtons(tasks: Task[]) {
  return Markup.inlineKeyboard(tasks.map((task) => [Markup.button.callback(`${task.title} - ${task.rewardPerWorker} BDT`, `task:${task.id}`)]));
}

export function taskActionButtons(task: Task, language?: LanguageCode) {
  const messages = getMessages(language);
  const buttons = task.approvalType === "manual"
    ? [[Markup.button.callback(messages.buttons.submitProof, `proof:${task.id}`)]]
    : [[Markup.button.callback(messages.buttons.verifyNow, `verify:${task.id}`)]];
  return Markup.inlineKeyboard(buttons);
}

export function formatTask(task: Task, language?: LanguageCode): string {
  const messages = getMessages(language);
  const category = messages.categories[task.category as keyof typeof messages.categories] ?? task.category;
  const labels = language === "bn"
    ? {
      category: "ক্যাটাগরি:",
      reward: "রিওয়ার্ড:",
      workers: "ওয়ার্কার:",
      verification: "ভেরিফিকেশন:",
      visitTimer: "ভিজিট টাইমার:",
      instructions: "ইনস্ট্রাকশন:",
      buyerApproval: "buyer/admin approval"
    }
    : {
      category: "Category:",
      reward: "Reward:",
      workers: "Workers:",
      verification: "Verification:",
      visitTimer: "Visit timer:",
      instructions: "Instructions:",
      buyerApproval: "buyer/admin approval"
    };
  const verify = task.approvalType === "auto"
    ? `\n${labels.verification} ${task.verificationType ?? "auto"}`
    : `\n${labels.verification} ${labels.buyerApproval}`;

  return [
    `💼 ${task.title}`,
    "",
    `${labels.category} ${category}`,
    `${labels.reward} ${task.rewardPerWorker} BDT`,
    `${labels.workers} ${task.completedCount}/${task.workerLimit}`,
    `${labels.verification} ${task.approvalType}${verify}`,
    task.websiteVisitSeconds ? `${labels.visitTimer} ${task.websiteVisitSeconds}s` : undefined,
    "",
    labels.instructions,
    task.instructions
  ].filter(Boolean).join("\n");
}
