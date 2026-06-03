const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 6174);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return data;
}

async function fetchStatus(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.status;
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      await fetchJson("/healthz");
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("Server did not become healthy within 10s");
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  try {
    await waitForServer();
    await fetchStatus("/");
    await fetchStatus("/admin");
    const activities = await fetchJson("/api/public/activities");
    if (!Array.isArray(activities.activities) || activities.activities.length < 1) {
      throw new Error("Activity list is empty");
    }
    console.log(`Smoke test passed: ${activities.activities.length} activities`);
  } finally {
    child.kill("SIGTERM");
    await wait(300);
    if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
  }

  if (output.includes("EADDRINUSE")) {
    throw new Error(output);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
