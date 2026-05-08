import { config } from "./config.js";
import type { LanguageCode } from "./messages.js";

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatMoney(amountBdt: number, language?: LanguageCode): string {
  if (language === "en") {
    return `$${roundMoney(amountBdt / config.usdToBdt).toFixed(2)}`;
  }
  return `${roundMoney(amountBdt)} BDT`;
}

export function formatMoneyDetail(amountBdt: number, language?: LanguageCode): string {
  if (language === "en") {
    return `${formatMoney(amountBdt, language)} (${roundMoney(amountBdt)} BDT)`;
  }
  return formatMoney(amountBdt, language);
}
