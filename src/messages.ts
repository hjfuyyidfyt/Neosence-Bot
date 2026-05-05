export const messages = {
  en: {
    common: {
      cancel: "Cancel",
      back: "Back",
      draftExpired: "This draft expired. Start again with /posttask.",
      switchToBuyer: "Switch to Buyer Mode to post a task.",
      noTasksAvailable: "No tasks are available right now.",
      incompleteDraft: "This draft is incomplete. Start again with /posttask.",
      sendText: "Please send a text answer.",
      currentInputCancelled: "Current draft/input cancelled.",
      banned: "Your Neosence account is banned. Contact support if this is a mistake."
    },
    start: {
      welcome: "Welcome to Neosence Bot.",
      chooseMode: "Choose how you want to use Neosence right now:",
      currentWorkspace: "Current workspace:"
    },
    menu: {
      postTask: "💼 Post Task",
      campaigns: "📊 Campaigns",
      submissions: "🧾 Submissions",
      balance: "💰 Balance",
      freelancerMode: "🔄 Freelancer Mode",
      buyerMode: "🔄 Buyer Mode",
      profile: "👤 Profile",
      support: "🛟 Support",
      earnMoney: "💼 Earn Money",
      myJobs: "📌 My Jobs",
      wallet: "💰 Wallet",
      withdraw: "🏦 Withdraw",
      referrals: "🤝 Referrals",
      workAsFreelancer: "💼 Work as Freelancer",
      hireAsBuyer: "📣 Hire as Buyer",
      language: "🌐 Language"
    },
    buttons: {
      submitProof: "Submit Proof",
      verifyNow: "Verify Now",
      previous: "Previous",
      next: "Next",
      useTemplate: "Use Template",
      editInstruction: "Edit Instruction",
      publishTask: "Publish Task",
      manualApproval: "Manual Approval",
      autoVerification: "Auto Verification"
    },
    categories: {
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
    },
    verificationMethods: {
      autoJoin: "Auto Join",
      timerVisit: "Timer Visit",
      autoAnswer: "Auto Answer",
      manualProof: "Manual Proof",
      webhook: "Webhook/API",
      appTracking: "App Tracking",
      inAppCode: "In-App Code",
      telegramJoin: "Telegram Join",
      websiteVisit: "Website Visit",
      websiteWebhook: "Website Webhook",
      appAttribution: "App Attribution",
      quiz: "Quiz"
    },
    taskWizard: {
      chooseCategory: "💼 Choose a task category:",
      chooseVerification: "🧭 Choose a verification method:",
      enterTitle: "Enter the task title.",
      enterCategory: "Enter a category. Example: telegram, website, app, social, survey",
      chooseApproval: "Choose an approval method:",
      enterReward: "💰 Enter reward per worker.\n\nExample: 5",
      invalidReward: "Enter a valid reward amount. Example: 5",
      enterWorkers: "How many workers do you need?\n\nExample: 100",
      invalidWorkers: "Enter a valid worker count. Example: 100",
      enterInstruction: "Write clear instructions for workers.",
      editInstruction: "Write the custom instruction.",
      instructionOrTemplate: "Write the instruction, or send /skip to use the template.",
      templateReadyTitle: "🧾 Instruction template ready",
      templateChoice: "Use this template or edit it?",
      autoVerificationType: "Choose the auto verification type:",
      published: "✅ Task published",
      cancelled: "Draft cancelled.",
      commandFields: "This command needs at least 6 fields. Send /posttask with no text to use the guided wizard.",
      invalidCommandFields: "Approval must be manual/auto. Reward must be a number and workers must be a whole number.",
      reviewTitle: "Review task before publishing:",
      useButtons: "Use the buttons for this step, or press Cancel.",
      telegramChatIdPrompt: [
        "Send the numeric Telegram channel/group chat ID.",
        "Add this bot as an admin in that channel/group first.",
        "Neosence will automatically detect admin access and keep the chat in the added list.",
        "Example: -1001234567890"
      ].join("\n"),
      invalidTelegramChatId: "Enter the numeric channel/group chat ID.\n\nExample: -1001234567890",
      telegramAdminMissing: [
        "I cannot access this chat yet.",
        "Add this bot as an admin in the target channel/group. I will detect it automatically.",
        "After adding the bot, send the same ID again to continue."
      ].join("\n"),
      telegramAdminDetected: "Bot admin access detected.",
      telegramTaskReady: "Telegram join task ready to publish.",
      websiteTargetPrompt: "Send the tracking target URL. Example: https://example.com",
      webhookTargetPrompt: "Send the webhook/event name or target URL.",
      appTargetPrompt: "Send the app/package/deep link target.",
      inAppCodePrompt: "Send the verification code rule or target app info.",
      quizAnswerPrompt: "Send the correct quiz answer/code. Workers who submit the same answer can be auto-paid.",
      websiteTimerPrompt: "Enter visit timer in seconds.\n\nExamples: 30, 60, 120",
      invalidWebsiteTimer: "Enter a valid timer between 5 and 600 seconds."
    },
    earn: {
      chooseCategory: "💼 Choose a task category:",
      noCategoryTasks: "No tasks are available in this category.",
      backToCategories: "Back to Categories",
      taskListTitle: "💼 {category} Tasks\nPage {page}/{totalPages}",
      myJobsHelp: "📌 Use /mytasks to see your accepted jobs and submissions."
    },
    wallet: {
      buyerTitle: "💰 Buyer Balance",
      freelancerTitle: "💰 Freelancer Wallet",
      userId: "User ID:",
      available: "Available:",
      pending: "Pending:",
      withdrawable: "Withdrawable:",
      escrowLocked: "Escrow locked:",
      autoHold: "Auto earning hold:",
      deposit: "Deposit",
      depositHelp: "Send payment to admin/payment number, then submit request:",
      withdraw: "Withdraw",
      withdrawRequest: "Withdraw Request",
      format: "Format:"
    },
    profile: {
      title: "👤 Neosence Profile",
      wallet: "Wallet",
      activity: "Activity"
    },
    support: {
      prompt: "🛟 Send your support message. Your next message will create a support ticket."
    },
    campaigns: {
      none: "No campaigns yet. Use Post Task to create your first campaign.",
      noSubmissions: "No campaign submissions yet.",
      recentSubmissions: "Recent campaign submissions:",
      paused: "Campaign paused:",
      resumed: "Campaign resumed:"
    },
    language: {
      title: "🌐 Language",
      current: "Current language:",
      choose: "Choose your preferred language:",
      english: "English",
      bangla: "Bangla",
      englishSet: "Language set to English.",
      banglaSet: "Language set to Bangla. Some messages may still appear in English while translation is being completed."
    }
  }
} as const;

export type LanguageCode = keyof typeof messages | "bn";

export function getMessages(language?: string) {
  if (language === "en") return messages.en;
  return messages.en;
}

export const t = messages.en;
