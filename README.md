# Neosence Bot

Neosence Bot is a Telegram micro-task marketplace MVP. Users can switch between freelancer and buyer mode anytime, post tasks, complete tasks, submit proof, and earn through wallet transactions.

## MVP Features

- Freelancer and buyer mode switch
- Manual approval tasks with proof submission
- Auto verification task foundation
- Telegram channel/group join verification via `getChatMember`
- Buyer escrow budget lock
- Wallet ledger with pending, available, withdrawable, and escrow balances
- Admin task approval, proof review, and withdrawal handling commands

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment file:

```bash
copy .env.example .env
```

3. Set `BOT_TOKEN` and `ADMIN_IDS` in `.env`.

4. Run in development:

```bash
npm run dev
```

## Railway Deploy

Neosence is Railway-ready. Use GitHub as the source repo and add a Railway Postgres database.

Required Railway variables:

```text
BOT_TOKEN=your_telegram_bot_token
ADMIN_IDS=your_telegram_user_id
DATABASE_URL=your_postgres_connection_string
PLATFORM_FEE_PERCENT=15
AUTO_WITHDRAW_HOLD_HOURS=24
REFERRAL_BONUS_BDT=1
```

Railway will run:

```bash
npm run build
npm run start
```

The app exposes `/health` so Railway can check the deployment. The Telegram bot currently uses long polling, so no public webhook setup is required for MVP testing.

Railway Postgres or Neon Postgres both work. Keep the database URL only in Railway variables, never in git.

After pushing a change, wait until Railway is serving the latest commit:

```bash
npm run verify:deploy -- https://your-app.up.railway.app
```

The health response includes service name, version, environment, start time, and commit hash when Railway provides it.

## Bot Commands

- `/start` - open main menu
- `/mode` - switch freelancer/buyer mode
- `/earn` - browse available tasks
- `/posttask` - create a task with the guided buyer wizard
- `/mytasks` - view owned or accepted tasks
- `/wallet` - wallet summary
- `/withdraw 100 bkash:01XXXXXXXXX` - request withdrawal
- `/admin` - admin dashboard
- `/deposit <userId> <amount> <note>` - admin adds buyer/freelancer balance
- `/user <userId>` - admin user lookup with wallet and activity summary
- `/approve <submissionId>` - approve proof
- `/reject <submissionId> <reason>` - reject proof
- `/paywithdraw <withdrawalId>` - admin marks withdrawal paid
- `/rejectwithdraw <withdrawalId> <reason>` - admin rejects withdrawal

## Mode-Specific Menu

Freelancer mode shows worker actions only:

```text
Earn Money
My Jobs
Wallet
Withdraw
Referrals
Switch to Buyer
Support
```

Buyer mode shows campaign actions only:

```text
Post Task
My Campaigns
Submissions
Deposit / Balance
Switch to Freelancer
Support
```

`Post Task` starts a guided wizard:

```text
Title
Category
Approval method
Reward per worker
Worker limit
Instructions
Auto verification type and target, when needed
Final publish confirmation
```

## Auto Verification Notes

For Telegram channel/group join tasks, add the bot to the target channel or group so it can call `getChatMember`. Use the target chat ID or public `@username` as the verification target.

Website and app auto verification are represented in the model as `website_visit`, `website_webhook`, `app_attribution`, and `in_app_code`; integrations can be added behind the same verification event system.

## Review Flow

- Buyers can open `Submissions` in buyer mode and review pending proof with buttons.
- Admins can use `/admin` to see pending submissions and withdrawals with quick action buttons.
- Command fallbacks still work for admin operations: `/approve`, `/reject`, `/paywithdraw`, and `/rejectwithdraw`.

## Campaign Controls

Buyers can open `My Campaigns` to view campaign status and stats. Active campaigns can be paused, paused campaigns can be resumed, and active/paused campaigns can be cancelled after pending submissions are reviewed. Cancelling refunds outstanding escrow back to the buyer wallet.

## Wallet UX

Wallet text changes by mode. Freelancer mode highlights withdrawable balance and `/withdraw`; buyer mode highlights User ID and manual deposit instructions for admin-confirmed deposits.

## Referrals

Freelancers can open `Referrals` to get their invite link. New users who start the bot with `?start=ref_<userId>` are tracked once, self-referrals are ignored, and the referrer receives the configured `REFERRAL_BONUS_BDT`.
