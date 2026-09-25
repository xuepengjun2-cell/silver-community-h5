// 并发回归测试用的内存版 mysql2/promise，只覆盖 server.js 用到的 SQL 形态。
// 每条查询都会让出事件循环，使并发请求像连真实 MySQL 时一样交错执行；遇到未覆盖的 SQL 直接报错。
const fs = require("fs");

const tables = {};
const PK = { sessions: "token", site_config: "k", activity_hub_sso_tickets: "jti" };
const seedFile = process.env.FAKE_DB_SEED;
if (seedFile && fs.existsSync(seedFile)) Object.assign(tables, JSON.parse(fs.readFileSync(seedFile, "utf8")));

function table(name) { return (tables[name] = tables[name] || []); }
function dump() { if (process.env.FAKE_DB_DUMP) fs.writeFileSync(process.env.FAKE_DB_DUMP, JSON.stringify(tables)); }
function dup(key) { const e = new Error(`Duplicate entry '${key}' for key 'PRIMARY'`); e.code = "ER_DUP_ENTRY"; return e; }
const tick = () => new Promise(resolve => setTimeout(resolve, Math.random() * 3));

async function query(sql, params = []) {
  await tick();
  const s = String(sql).replace(/\s+/g, " ").trim();
  let m;
  if (/^CREATE TABLE/i.test(s)) return [{}, []];
  if ((m = s.match(/^SELECT COUNT\(\*\) AS (\w+) FROM (\w+)/i))) return [[{ [m[1]]: table(m[2]).length }], []];
  if ((m = s.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY .+?)?(?: LIMIT \d+)?$/i))) {
    const [, , name, where] = m;
    let rows = table(name);
    if (where) {
      if (/^id = \?$/i.test(where)) rows = rows.filter(r => r.id === params[0]);
      else if (/^id\s*<>\s*\?$/i.test(where)) rows = rows.filter(r => r.id !== params[0]);
      else if ((m = where.match(/^status = '(\w+)'$/i))) rows = rows.filter(r => r.status === m[1]);
      else rows = [];
    }
    return [rows.map(r => ({ ...r })), []];
  }
  if ((m = s.match(/^DELETE FROM (\w+)(?: WHERE (.+))?$/i))) {
    const [, name, where] = m;
    const before = table(name).length;
    if (!where) tables[name] = [];
    else if (/^id NOT IN/i.test(where)) tables[name] = table(name).filter(r => params.includes(r.id));
    else if (/^token = \?$/i.test(where)) tables[name] = table(name).filter(r => r.token !== params[0]);
    else if (/^expires_at < \?$/i.test(where)) tables[name] = table(name).filter(r => !(String(r.expires_at) < String(params[0])));
    dump();
    return [{ affectedRows: before - table(name).length }, []];
  }
  if ((m = s.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES (\?|\(.+?\))( ON DUPLICATE KEY UPDATE .+)?$/i))) {
    const [, name, colList, valuesPart, upsert] = m;
    const cols = colList.split(",").map(c => c.trim());
    const rows = valuesPart === "?" ? params[0] : [params];
    const pk = PK[name] || cols[0];
    for (const values of rows) {
      const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
      const list = table(name);
      if (name === "audit_logs") { list.push(row); continue; }
      const at = list.findIndex(r => r[pk] === row[pk]);
      if (at >= 0) {
        if (!upsert) throw dup(row[pk]);
        list[at] = { ...list[at], ...row };
      } else list.push(row);
      await tick();
    }
    dump();
    return [{ affectedRows: rows.length }, []];
  }
  if ((m = s.match(/^UPDATE (\w+) SET (.+) WHERE id = \?$/i))) {
    const [, name, assignments] = m;
    const cols = assignments.split(",").map(a => a.split("=")[0].trim());
    const row = table(name).find(r => r.id === params[params.length - 1]);
    if (row) cols.forEach((c, i) => { row[c] = params[i]; });
    dump();
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  throw new Error(`fake-mysql: unsupported SQL: ${s.slice(0, 120)}`);
}

function createPool() {
  return {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    }
  };
}

module.exports = { createPool };
