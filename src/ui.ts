import { Markup } from "telegraf";
import type { Task, UserProfile } from "./types.js";

export function mainMenu(user: UserProfile) {
  if (user.mode === "buyer") {
    return Markup.inlineKeyboard([
      [Markup.button.callback("Post Task", "menu:post")],
      [Markup.button.callback("My Campaigns", "menu:campaigns"), Markup.button.callback("Submissions", "menu:submissions")],
      [Markup.button.callback("Deposit / Balance", "menu:wallet"), Markup.button.callback("Switch to Freelancer", "mode:freelancer")],
      [Markup.button.callback("Profile", "menu:profile"), Markup.button.callback("Support", "menu:support")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("Earn Money", "menu:earn")],
    [Markup.button.callback("My Jobs", "menu:jobs"), Markup.button.callback("Wallet", "menu:wallet")],
    [Markup.button.callback("Withdraw", "menu:withdraw"), Markup.button.callback("Switch to Buyer", "mode:buyer")],
    [Markup.button.callback("Referrals", "menu:referrals"), Markup.button.callback("Profile", "menu:profile")],
    [Markup.button.callback("Support", "menu:support")]
  ]);
}

export function modeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Work as Freelancer", "mode:freelancer")],
    [Markup.button.callback("Hire as Buyer", "mode:buyer")]
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
    `Task: ${task.title}`,
    `Category: ${task.category}`,
    `Reward: ${task.rewardPerWorker} BDT`,
    `Workers: ${task.completedCount}/${task.workerLimit}`,
    `Type: ${task.approvalType}${verify}`,
    "",
    "Instructions:",
    task.instructions
  ].join("\n");
}
