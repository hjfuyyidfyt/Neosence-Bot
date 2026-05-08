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

export type MessageBundle<T = typeof messages.en> = {
  [K in keyof T]: T[K] extends string ? string : MessageBundle<T[K]>;
};

const banglaMessages: MessageBundle = {
  common: {
    cancel: "বাতিল",
    back: "ফিরে যান",
    draftExpired: "এই ড্রাফটের সময় শেষ হয়েছে। /posttask দিয়ে আবার শুরু করুন।",
    switchToBuyer: "টাস্ক পোস্ট করতে Buyer Mode এ যান।",
    noTasksAvailable: "এখন কোনো টাস্ক নেই।",
    incompleteDraft: "এই ড্রাফট অসম্পূর্ণ। /posttask দিয়ে আবার শুরু করুন।",
    sendText: "অনুগ্রহ করে টেক্সট উত্তর পাঠান।",
    currentInputCancelled: "বর্তমান ড্রাফট/ইনপুট বাতিল করা হয়েছে।",
    banned: "আপনার Neosence অ্যাকাউন্ট ব্যান করা হয়েছে। ভুল হলে সাপোর্টে যোগাযোগ করুন।"
  },
  start: {
    welcome: "Neosence Bot এ স্বাগতম।",
    chooseMode: "এখন আপনি কীভাবে Neosence ব্যবহার করতে চান?",
    currentWorkspace: "বর্তমান ওয়ার্কস্পেস:"
  },
  menu: {
    postTask: "💼 টাস্ক পোস্ট",
    campaigns: "📊 ক্যাম্পেইন",
    submissions: "🧾 সাবমিশন",
    balance: "💰 ব্যালেন্স",
    freelancerMode: "🔄 ফ্রিল্যান্সার মোড",
    buyerMode: "🔄 বায়ার মোড",
    profile: "👤 প্রোফাইল",
    support: "🛟 সাপোর্ট",
    earnMoney: "💼 আয় করুন",
    myJobs: "📌 আমার কাজ",
    wallet: "💰 ওয়ালেট",
    withdraw: "🏦 টাকা তুলুন",
    referrals: "🤝 রেফারেল",
    workAsFreelancer: "💼 Freelancer হিসেবে কাজ",
    hireAsBuyer: "📣 Buyer হিসেবে হায়ার",
    language: "🌐 ভাষা"
  },
  buttons: {
    submitProof: "প্রুফ জমা দিন",
    verifyNow: "এখন Verify করুন",
    previous: "আগের পেজ",
    next: "পরের পেজ",
    useTemplate: "Template ব্যবহার",
    editInstruction: "Instruction এডিট",
    publishTask: "টাস্ক পাবলিশ",
    manualApproval: "ম্যানুয়াল approval",
    autoVerification: "অটো verification"
  },
  categories: {
    all: "সব",
    telegram: "টেলিগ্রাম",
    website: "ওয়েবসাইট",
    app: "অ্যাপ",
    social: "সোশ্যাল",
    survey: "সার্ভে",
    data_entry: "ডাটা এন্ট্রি",
    review: "রিভিউ",
    quiz: "কুইজ / কোড",
    custom: "কাস্টম"
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
    chooseCategory: "💼 টাস্ক ক্যাটাগরি বেছে নিন:",
    chooseVerification: "🧭 Verification method বেছে নিন:",
    enterTitle: "টাস্কের title লিখুন।",
    enterCategory: "ক্যাটাগরি লিখুন। যেমন: telegram, website, app, social, survey",
    chooseApproval: "Approval method বেছে নিন:",
    enterReward: "💰 প্রতি worker reward লিখুন।\n\nযেমন: 5",
    invalidReward: "সঠিক reward amount লিখুন। যেমন: 5",
    enterWorkers: "কতজন worker লাগবে?\n\nযেমন: 100",
    invalidWorkers: "সঠিক worker count লিখুন। যেমন: 100",
    enterInstruction: "Workers এর জন্য পরিষ্কার instruction লিখুন।",
    editInstruction: "Custom instruction লিখুন।",
    instructionOrTemplate: "Instruction লিখুন, অথবা template ব্যবহার করতে /skip পাঠান।",
    templateReadyTitle: "🧾 Instruction template ready",
    templateChoice: "এই template ব্যবহার করবেন নাকি এডিট করবেন?",
    autoVerificationType: "Auto verification type বেছে নিন:",
    published: "✅ টাস্ক পাবলিশ হয়েছে",
    cancelled: "ড্রাফট বাতিল হয়েছে।",
    commandFields: "এই command এর জন্য কমপক্ষে ৬টি field দরকার। Guided wizard ব্যবহার করতে শুধু /posttask পাঠান।",
    invalidCommandFields: "Approval manual/auto হতে হবে। Reward number এবং workers whole number হতে হবে।",
    reviewTitle: "পাবলিশ করার আগে টাস্ক review করুন:",
    useButtons: "এই ধাপের জন্য button ব্যবহার করুন, অথবা Cancel চাপুন।",
    telegramChatIdPrompt: [
      "Telegram channel/group এর numeric chat ID পাঠান।",
      "আগে এই bot-কে ওই channel/group এ admin করুন।",
      "Admin access পেলে Neosence automatically added list এ রাখবে।",
      "Example: -1001234567890"
    ].join("\n"),
    invalidTelegramChatId: "Numeric channel/group chat ID লিখুন।\n\nExample: -1001234567890",
    telegramAdminMissing: [
      "এই chat এ bot access পাচ্ছে না।",
      "Target channel/group এ bot-কে admin করুন। আমি automatically detect করব।",
      "Bot add করার পর একই ID আবার পাঠান।"
    ].join("\n"),
    telegramAdminDetected: "Bot admin access detect হয়েছে।",
    telegramTaskReady: "Telegram join task publish করার জন্য ready.",
    websiteTargetPrompt: "Tracking target URL পাঠান। Example: https://example.com",
    webhookTargetPrompt: "Webhook/event name বা target URL পাঠান।",
    appTargetPrompt: "App/package/deep link target পাঠান।",
    inAppCodePrompt: "Verification code rule বা target app info পাঠান।",
    quizAnswerPrompt: "সঠিক quiz answer/code পাঠান। Worker একই answer দিলে auto reward পাবে।",
    websiteTimerPrompt: "Visit timer seconds এ লিখুন।\n\nExamples: 30, 60, 120",
    invalidWebsiteTimer: "৫ থেকে ৬০০ seconds এর মধ্যে valid timer লিখুন।"
  },
  earn: {
    chooseCategory: "💼 টাস্ক ক্যাটাগরি বেছে নিন:",
    noCategoryTasks: "এই category তে কোনো task নেই।",
    backToCategories: "Categories এ ফিরুন",
    taskListTitle: "💼 {category} Tasks\nPage {page}/{totalPages}",
    myJobsHelp: "📌 আপনার accepted jobs এবং submissions দেখতে /mytasks ব্যবহার করুন।"
  },
  wallet: {
    buyerTitle: "💰 বায়ার ব্যালেন্স",
    freelancerTitle: "💰 ফ্রিল্যান্সার ওয়ালেট",
    userId: "ইউজার ID:",
    available: "Available:",
    pending: "Pending:",
    withdrawable: "তোলার মতো:",
    escrowLocked: "Escrow locked:",
    autoHold: "Auto earning hold:",
    deposit: "ডিপোজিট",
    depositHelp: "Admin/payment number এ payment পাঠিয়ে request submit করুন:",
    withdraw: "টাকা তুলুন",
    withdrawRequest: "Withdraw Request",
    format: "ফরম্যাট:"
  },
  profile: {
    title: "👤 প্রোফাইল",
    wallet: "💰 ওয়ালেট",
    activity: "📌 কার্যক্রম"
  },
  support: {
    prompt: "🛟 আপনার support message পাঠান। আপনার next message support ticket তৈরি করবে।"
  },
  campaigns: {
    none: "এখনো কোনো campaign নেই। প্রথম campaign তৈরি করতে Post Task ব্যবহার করুন।",
    noSubmissions: "এখনো কোনো campaign submission নেই।",
    recentSubmissions: "Recent campaign submissions:",
    paused: "Campaign paused:",
    resumed: "Campaign resumed:"
  },
  language: {
    title: "🌐 ভাষা",
    current: "বর্তমান ভাষা:",
    choose: "আপনার পছন্দের ভাষা বেছে নিন:",
    english: "English",
    bangla: "বাংলা",
    englishSet: "Language set to English.",
    banglaSet: "ভাষা বাংলা সেট করা হয়েছে।"
  }
};

export type LanguageCode = keyof typeof messages | "bn";

export function getMessages(language?: string) {
  if (language === "bn") return banglaMessages;
  if (language === "en") return messages.en;
  return messages.en;
}

export const t = messages.en;
