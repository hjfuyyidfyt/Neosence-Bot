import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.argv[2] ?? process.env.DEPLOY_URL;
const expectedCommit = process.argv[3] ?? getCurrentCommit();
const timeoutMs = Number(process.env.DEPLOY_WAIT_TIMEOUT_MS ?? 300000);
const intervalMs = Number(process.env.DEPLOY_WAIT_INTERVAL_MS ?? 20000);

if (!url) {
  console.error("Usage: node scripts/wait-deploy.mjs <deploy-url> [expected-commit]");
  process.exitCode = 2;
  throw new Error("Missing deploy URL");
}

const healthUrl = new URL("/health", normalizeUrl(url)).toString();
const startedAt = Date.now();
let attempts = 0;
let verified = false;

while (Date.now() - startedAt < timeoutMs) {
  attempts += 1;

  try {
    const response = await fetch(healthUrl, { headers: { accept: "application/json" } });
    const body = await response.json();
    const runningCommit = String(body.commit ?? "");
    const matches = expectedCommit === "unknown" || runningCommit.startsWith(expectedCommit.slice(0, 7));

    console.log(
      `[${attempts}] ${response.status} ${body.service ?? "unknown"} commit=${runningCommit} expected=${expectedCommit}`
    );

    if (response.ok && body.ok === true && matches) {
      console.log("Deploy is healthy and running the expected commit.");
      verified = true;
      break;
    }
  } catch (error) {
    console.log(`[${attempts}] waiting: ${error.message}`);
  }

  await sleep(intervalMs);
}

if (!verified) {
  console.error(`Deploy did not reach expected commit within ${Math.round(timeoutMs / 1000)}s: ${healthUrl}`);
  process.exitCode = 1;
}

function normalizeUrl(value) {
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://${value}`;
}

function getCurrentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
