const test = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { activitySopPdf } = require("../server/sop-pdf");

test("中文活动方案生成标准 PDF 文件，含长篇多页流程", async () => {
  const chunks = [];
  const output = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
  const finished = new Promise((resolve, reject) => { output.on("finish", resolve); output.on("error", reject); });
  const pdf = activitySopPdf({
    title: "复古国潮肖像美拍活动",
    intro: "银发社群活动执行方案",
    category: "摄影", city: "北京",
    highlights: ["体验民国风格造型", "拍摄个人肖像"],
    schedule: [{ time: "09:00", item: "签到与破冰" }, { time: "10:00", item: "造型与拍摄" }],
    plan: { target: "完成现场体验与活动后回访。".repeat(200), materials: "服装、相机与灯光", staffing: "主理人、摄影师", conversion: "24 小时内私聊", risk: "现场安全预案" }
  });
  pdf.pipe(output);
  pdf.end();
  await finished;
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.subarray(0, 8).toString(), "%PDF-1.3");
  assert.ok(bytes.length > 10000);
  assert.ok((bytes.toString("latin1").match(/\/Type \/Page\b/g) || []).length >= 2);
});
