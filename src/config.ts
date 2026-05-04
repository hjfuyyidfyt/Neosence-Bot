import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  ADMIN_IDS: z.string().default(""),
  DATABASE_URL: z.string().optional(),
  DATA_FILE: z.string().default("./data/neosence-store.json"),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(50).default(15),
  AUTO_WITHDRAW_HOLD_HOURS: z.coerce.number().min(0).default(24),
  REFERRAL_BONUS_BDT: z.coerce.number().min(0).default(1),
  PORT: z.coerce.number().default(3000)
});

const env = envSchema.parse(process.env);

export const config = {
  botToken: env.BOT_TOKEN,
  databaseUrl: env.DATABASE_URL,
  adminIds: env.ADMIN_IDS.split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id)),
  dataFile: env.DATA_FILE,
  platformFeePercent: env.PLATFORM_FEE_PERCENT,
  autoWithdrawHoldHours: env.AUTO_WITHDRAW_HOLD_HOURS,
  referralBonusBdt: env.REFERRAL_BONUS_BDT,
  port: env.PORT
};

export function isAdmin(userId: number): boolean {
  return config.adminIds.includes(userId);
}
