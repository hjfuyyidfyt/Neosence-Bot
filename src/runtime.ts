export const runtime = {
  service: "neosence-bot",
  version: "0.1.0",
  commit: process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.RAILWAY_DEPLOYMENT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.SOURCE_COMMIT ??
    "local",
  environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
  startedAt: new Date().toISOString()
};
