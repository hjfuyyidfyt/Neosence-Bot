import { Markup } from "telegraf";
import type { Task, UserProfile } from "./types.js";
import { getMessages } from "./messages.js";
import type { LanguageCode } from "./messages.js";
import { formatMoney } from "./money.js";

export function mainMenu(user: UserProfile) {
  const t = getMessages(user.language);
  if (user.mode === "buyer") {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t.menu.postTask, "menu:post")],
      [Markup.button.callback(t.menu.campaigns, "menu:campaigns"), Markup.button.callback(t.menu.submissions, "menu:submissions")],
      [Markup.button.callback(t.menu.balance, "menu:wallet"), Markup.button.callback(t.menu.buyerMode, "mode:freelancer")],
      [Markup.button.callback(t.menu.profile, "menu:profile"), Markup.button.callback(t.menu.language, "menu:language")],
      [Markup.button.callback(t.menu.support, "menu:support")]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(t.menu.earnMoney, "menu:earn")],
    [Markup.button.callback(t.menu.myJobs, "menu:jobs"), Markup.button.callback(t.menu.wallet, "menu:wallet")],
    [Markup.button.callback(t.menu.referrals, "menu:referrals"), Markup.button.callback(t.menu.profile, "menu:profile")],
    [Markup.button.callback(t.menu.freelancerMode, "mode:buyer"), Markup.button.callback(t.menu.language, "menu:language")],
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
  return Markup.inlineKeyboard(tasks.map((task) => [Markup.button.callback(`${task.title} - ${formatMoney(task.rewardPerWorker)}`, `task:${task.id}`)]));
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
      reward: "রিওয়ার্ড",
      workers: "ওয়ার্কার",
      verify: "ভেরিফাই",
      visitTimer: "ভিজিট টাইমার",
      instructions: "ইনস্ট্রাকশন"
    }
    : {
      reward: "Reward",
      workers: "Workers",
      verify: "Verify",
      visitTimer: "Visit timer",
      instructions: "Instructions"
    };

  return [
    `💼 ${task.title}`,
    "",
    `${categoryIcon(task.category)} ${category}`,
    `💵 ${labels.reward}: ${formatMoney(task.rewardPerWorker, language)}`,
    `👥 ${labels.workers}: ${task.completedCount}/${task.workerLimit}`,
    `✅ ${labels.verify}: ${verificationLabel(task, language)}`,
    task.websiteVisitSeconds ? `⏱ ${labels.visitTimer}: ${task.websiteVisitSeconds}s` : undefined,
    "",
    `📌 ${labels.instructions}`,
    task.instructions
  ].filter((line): line is string => line !== undefined).join("\n");
}

function categoryIcon(category: string): string {
  if (category === "telegram") return "📢";
  if (category === "website") return "🌐";
  if (category === "app") return "📱";
  if (category === "social") return "📣";
  if (category === "survey") return "📝";
  if (category === "data_entry") return "⌨️";
  if (category === "review") return "⭐";
  if (category === "quiz") return "✅";
  return "⚙️";
}

function verificationLabel(task: Task, language?: LanguageCode): string {
  const labels = language === "bn"
    ? {
      manual: "ম্যানুয়াল প্রুফ",
      telegram_join: "টেলিগ্রাম জয়েন",
      website_visit: "টাইমার ভিজিট",
      website_webhook: "Webhook/API",
      app_attribution: "অ্যাপ ট্র্যাকিং",
      in_app_code: "ইন-অ্যাপ কোড",
      quiz: "কুইজ/কোড",
      auto: "অটো ভেরিফাই"
    }
    : {
      manual: "Manual Proof",
      telegram_join: "Telegram Join",
      website_visit: "Timer Visit",
      website_webhook: "Webhook/API",
      app_attribution: "App Tracking",
      in_app_code: "In-App Code",
      quiz: "Quiz/Code",
      auto: "Auto Verify"
    };

  if (task.approvalType === "manual") return labels.manual;
  return labels[task.verificationType as keyof typeof labels] ?? labels.auto;
}
