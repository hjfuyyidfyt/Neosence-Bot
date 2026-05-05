export const messages = {
  en: {
    common: {
      cancel: "Cancel",
      draftExpired: "This draft expired. Start again with /posttask.",
      switchToBuyer: "Switch to Buyer Mode to post a task.",
      noTasksAvailable: "No tasks are available right now."
    },
    start: {
      welcome: "Welcome to Neosence Bot.",
      chooseMode: "Choose how you want to use Neosence right now:"
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
    taskWizard: {
      chooseCategory: "💼 Choose a task category:",
      chooseVerification: "🧭 Choose a verification method:",
      enterTitle: "Enter the task title.",
      enterReward: "💰 Enter reward per worker.\n\nExample: 5",
      enterWorkers: "How many workers do you need?\n\nExample: 100",
      enterInstruction: "Write clear instructions for workers.",
      editInstruction: "Write the custom instruction.",
      templateReadyTitle: "🧾 Instruction template ready",
      templateChoice: "Use this template or edit it?",
      published: "✅ Task published",
      cancelled: "Draft cancelled."
    },
    earn: {
      chooseCategory: "💼 Choose a task category:",
      noCategoryTasks: "No tasks are available in this category.",
      backToCategories: "Back to Categories"
    },
    support: {
      prompt: "🛟 Send your support message. Your next message will create a support ticket."
    },
    language: {
      title: "🌐 Language",
      current: "Current language:",
      choose: "Choose your preferred language:",
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
