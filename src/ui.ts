import { Markup } from "telegraf";
import type { Task, UserProfile } from "./types.js";

export function mainMenu(user: UserProfile) {
  const modeLabel = user.mode === "freelancer" ? "Freelancer" : "Buyer";
  return Markup.inlineKeyboard([
    [Markup.button.callback("Earn Money", "menu:earn"), Markup.button.callback("Post Task", "menu:post")],
    [Markup.button.callback("Wallet", "menu:wallet"), Markup.button.callback(`Mode: ${modeLabel}`, "menu:mode")],
    [Markup.button.callback("My Tasks", "menu:mytasks"), Markup.button.callback("Support", "menu:support")]
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
