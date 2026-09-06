// Minimal structured JSON logger. No deps, no color, no fluff.
// Output: one JSON object per line on stdout (12-factor friendly).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  return LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
}

function log(level, msg, fields = {}) {
  if (LEVELS[level] < currentLevel()) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  try {
    process.stdout.write(JSON.stringify(entry) + "\n");
  } catch (e) {
    // Last-resort: never let logging kill the process.
    process.stdout.write(
      JSON.stringify({ ts: entry.ts, level: "error", msg: "logger failure", err: String(e) }) + "\n"
    );
  }
}

export const logger = {
  debug: (msg, fields) => log("debug", msg, fields),
  info: (msg, fields) => log("info", msg, fields),
  warn: (msg, fields) => log("warn", msg, fields),
  error: (msg, fields) => log("error", msg, fields),
};
