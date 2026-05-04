# Neosence Bot Manual Test Checklist

Use this after Railway is serving the latest commit.

## Environment

- `BOT_TOKEN` is set in Railway.
- `ADMIN_IDS` includes tester admin Telegram IDs.
- `DATABASE_URL` points to Neon/Postgres.
- `PUBLIC_URL` is set to the Railway app URL, for example `https://web-production-7ac53.up.railway.app`.
- `/health` returns the latest expected commit.

## User And Menu

- `/start` creates or loads the user.
- Freelancer menu shows worker actions only.
- Switch to buyer shows buyer actions only.
- Switch back to freelancer restores worker menu.

## Buyer Campaigns

- Buyer opens `Post Task`.
- Wizard creates a manual task.
- Wizard creates an auto `telegram_join` task.
- Wizard creates an auto `website_visit` task.
- Wizard creates an auto `quiz` task.
- `My Campaigns` lists campaigns.
- Campaign detail shows stats and escrow.
- Active campaign can pause.
- Paused campaign can resume.
- Campaign with no pending submissions can cancel and refund unused escrow.

## Freelancer Work

- Freelancer sees available tasks in `Earn Money`.
- Freelancer cannot see own buyer task.
- Manual task accepts proof and creates pending submission.
- Screenshot/document proof stores Telegram file reference for review.
- Telegram join task verifies membership and pays reward.
- Website visit task gives tracking link, tracks visit, then pays reward.
- Quiz task accepts correct answer and pays reward.
- Duplicate submission is blocked.

## Review

- Buyer `Submissions` lists pending proof.
- Buyer can view proof.
- Buyer can approve proof and worker receives reward.
- Buyer can reject proof.
- Worker can dispute rejected proof with `/dispute <submissionId> <reason>`.
- Admin `/disputes` lists open disputes.
- Admin resolves dispute as worker-paid or rejection-upheld.
- Admin `/admin` shows pending submissions and withdrawals.
- Admin quick buttons approve/reject submissions.

## Wallet And Payments

- Buyer wallet shows User ID and deposit instruction.
- User `/depositreq 500 bkash trxid-or-proof-note` creates deposit request.
- Admin `/admin` shows pending deposit request.
- Admin approves deposit request and user balance increases.
- Admin `/deposit <userId> <amount> <note>` still adds manual balance.
- Freelancer wallet shows withdrawable amount.
- Auto-verified earning appears in available balance but is held from withdrawable balance during hold window.
- `/withdraw 100 bkash:...` creates withdrawal request.
- Admin `/paywithdraw <withdrawalId>` marks paid.
- Admin `/rejectwithdraw <withdrawalId> <reason>` refunds rejected withdrawal.

## Referrals

- Freelancer `Referrals` shows invite link.
- New user starts with `?start=ref_<userId>`.
- Referral is recorded once.
- Self-referral is ignored.
- Referrer bonus is added when `REFERRAL_BONUS_BDT` is greater than 0.

## Support And Safety

- User presses `Support` and sends message.
- Admin `/tickets` lists open tickets.
- Admin `/closeticket <ticketId>` closes ticket.
- Admin `/ban <userId>` blocks user actions.
- Admin `/unban <userId>` restores access.
