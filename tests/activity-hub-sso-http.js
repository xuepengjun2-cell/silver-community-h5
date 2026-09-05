const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const secret = "fixture-secret-at-least-thirty-two-characters";
const port = 18000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-activity-sso-"));
const now = Math.floor(Date.now() / 1000);
const claims = {
  v: 1,
  iss: "kkhc-channel-assistant-v2",
  aud: "silver-activity",
  sub: "store-fixture",
  u: "member",
  n: "测试门店",
  r: "operator",
  iat: now,
  exp: now + 120,
  accessExp: now + 300,
  jti: "http-fixture-ticket-12345678"
};
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const input = encode({ alg: "HS256", typ: "JWT" }) + "." + encode(claims);
const ticket = input + "." + crypto.createHmac("sha256", secret).update(input).digest("base64url");

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Silver HTTP test server did not start")), 5000);
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("Silver community H5 running")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== null && code !== 0) reject(new Error("Silver HTTP test server exited: " + code));
    });
  });
}

async function request(pathname, options) {
  return fetch("http://127.0.0.1:" + port + pathname, options);
}

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ACTIVITY_HUB_SSO_SECRET: secret },
  stdio: ["ignore", "pipe", "pipe"]
});

(async () => {
  try {
    await waitForServer(child);
    const sso = await request("/api/auth/sso", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ticket })
    });
    assert.equal(sso.status, 200);
    const cookie = sso.headers.get("set-cookie").split(";")[0];
    const me = await request("/api/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.username, "member");

    const replay = await request("/api/auth/sso", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ticket })
    });
    assert.equal(replay.status, 409);

    const originalLogin = await request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "member", password: "member123" })
    });
    assert.equal(originalLogin.status, 200);
    console.log("activity hub HTTP SSO, one-time replay protection and original password login passed");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
