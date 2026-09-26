const path = require("node:path");
const PDFDocument = require("pdfkit");

const FONT_PATH = path.join(__dirname, "fonts", "NotoSansCJKsc-Regular.otf");
const INK = "#2c2723";
const MUTED = "#6f665f";
const ACCENT = "#b9502e";

function value(input) {
  return String(input == null || input === "" ? "待补充" : input);
}

function room(doc, height = 52) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function section(doc, title, content) {
  const body = value(content);
  const fullHeight = doc.fontSize(10.5).heightOfString(body, { lineGap: 4 }) + 50;
  const pageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  room(doc, Math.min(fullHeight, pageHeight));
  doc.moveDown(0.65).fillColor(ACCENT).fontSize(14).text(title, { lineBreak: true });
  doc.moveDown(0.3).fillColor(INK).fontSize(10.5).text(body, { lineGap: 4 });
}

function numbered(values) {
  return (Array.isArray(values) ? values : []).filter(Boolean)
    .map((item, index) => `${index + 1}. ${item}`).join("\n") || "待补充";
}

function activitySopPdf(activity) {
  const doc = new PDFDocument({ size: "A4", margin: 52, compress: true });
  doc.info.Title = `${activity.title || "活动"}｜活动执行 SOP`;
  doc.info.Author = "开开华彩";
  doc.font(FONT_PATH);
  doc.on("pageAdded", () => {
    doc.font(FONT_PATH).fillColor(MUTED).fontSize(9).text("开开华彩 · 活动执行 SOP（续）");
    doc.moveDown(0.7);
  });

  doc.fillColor(ACCENT).fontSize(11).text("开开华彩 · 活动执行 SOP");
  doc.moveDown(0.45).fillColor(INK).fontSize(22).text(value(activity.title), { lineGap: 4 });
  doc.moveDown(0.45).fillColor(MUTED).fontSize(10).text(value(activity.intro), { lineGap: 3 });
  doc.moveDown(0.75);
  const info = [
    ["活动类型", [activity.category, activity.activityType].filter(Boolean).join(" · ")],
    ["城市/地区", [activity.city, activity.region].filter(Boolean).join(" / ")],
    ["参考价格", activity.price], ["适合人数", activity.capacity],
    ["活动时长", activity.duration], ["推荐地点", activity.location]
  ];
  for (const [label, detail] of info) {
    room(doc, 22);
    doc.fillColor(MUTED).fontSize(10).text(`${label}：${value(detail)}`, { lineGap: 2 });
  }
  doc.moveDown(0.5);
  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor("#e5d5c9").stroke();

  section(doc, "一、活动亮点", numbered(activity.highlights));
  const schedule = (Array.isArray(activity.schedule) ? activity.schedule : [])
    .filter(row => row && (row.time || row.item))
    .map((row, index) => `${index + 1}. ${row.time || "活动节点"}　${row.item || "待补充"}`)
    .join("\n");
  section(doc, "二、当日活动时间轴", schedule);

  const plan = activity.plan || {};
  [
    ["三、活动定位与转化目标", plan.target],
    ["四、所需物料", plan.materials],
    ["五、人员分工", plan.staffing],
    ["六、话术与转化承接", plan.conversion],
    ["七、注意事项与风险预案", plan.risk]
  ].forEach(([heading, body]) => section(doc, heading, body));
  section(doc, "八、活动执行与复盘核查", [
    "1. 活动前一天确认场地、人数、老师、摄影与应急物料。",
    "2. 签到后先破冰分组，按时间轴控场并照顾新客体验。",
    "3. 现场沉淀照片、视频、用户反馈和意向标签。",
    "4. 活动结束 24 小时内完成作品发布、群内互动、私聊回访及下一步邀约。"
  ].join("\n"));
  section(doc, "九、参考素材", `图片 ${(activity.images || []).length} 项 · 视频 ${(activity.videos || []).length} 项 · 参考链接 ${(activity.references || []).length} 项。素材请在活动详情页查看。`);
  return doc;
}

module.exports = { activitySopPdf };
