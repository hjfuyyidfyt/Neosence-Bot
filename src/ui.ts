import { Markup } from "telegraf";
import type { Task, UserProfile } from "./types.js";
import { t } from "./messages.js";

export function mainMenu(user: UserProfile) {
  if (user.mode === "buyer") {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t.menu.postTask, "menu:post")],
      [Markup.button.callback(t.menu.campaigns, "menu:campaigns"), Markup.button.callback(t.menu.submissions, "menu:submissions")],
      [Markup.button.callback(t.menu.balance, "menu:wallet"), Markup.button.callback(t.menu.freelancerMode, "mode:freelancer")],
      [Markup.button.callback(t.menu.profile, "menu:profile"), Markup.button.callback("🌐 Language", "menu:language")],
      [Markup.button.callback(t.menu.support, "menu:support")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(t.menu.earnMoney, "menu:earn")],
    [Markup.button.callback(t.menu.myJobs, "menu:jobs"), Markup.button.callback(t.menu.wallet, "menu:wallet")],
    [Markup.button.callback(t.menu.withdraw, "menu:withdraw"), Markup.button.callback(t.menu.buyerMode, "mode:buyer")],
    [Markup.button.callback(t.menu.referrals, "menu:referrals"), Markup.button.callback(t.menu.profile, "menu:profile")],
    [Markup.button.callback("🌐 Language", "menu:language")],
    [Markup.button.callback(t.menu.support, "menu:support")]
  ]);
}

export function modeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t.menu.workAsFreelancer, "mode:freelancer")],
    [Markup.button.callback(t.menu.hireAsBuyer, "mode:buyer")]
  ]);
}

export function taskButtons(tasks: Task[]) {
  return Markup.inlineKeyboard(tasks.map((task) => [Markup.button.callback(`${task.title} - ${task.rewardPerWorker} BDT`, `task:${task.id}`)]));
}

export function taskActionButtons(task: Task) {
  const buttons = task.approvalType === "manual"
    ? [[Markup.button.callback("Submit Proof", `proof:${task.id}`)]]
    : [[Markup.button.callback("Verify Now", `verify:${task.id}`)]];
  return Markup.inlineKeyboard(buttons);
}

export function formatTask(task: Task): string {
  const verify = task.approvalType === "auto"
    ? `\nVerification: ${task.verificationType ?? "auto"}`
    : "\nVerification: buyer/admin approval";

  return [
    `💼 ${task.title}`,
    "",
    `Category: ${task.category}`,
    `Reward: ${task.rewardPerWorker} BDT`,
    `Workers: ${task.completedCount}/${task.workerLimit}`,
    `Verification: ${task.approvalType}${verify}`,
    task.websiteVisitSeconds ? `Visit timer: ${task.websiteVisitSeconds}s` : undefined,
    "",
    "Instructions:",
    task.instructions
  ].filter(Boolean).join("\n");
}
