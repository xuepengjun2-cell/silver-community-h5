const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const auth = require('../utils/auth');

function pageAt(name) {
  let definition;
  global.Page = value => { definition = value; };
  const file = require.resolve(`../pages/${name}/index.js`);
  delete require.cache[file]; require(file); delete global.Page;
  return { ...definition, data: { ...definition.data }, setData(values, done) { Object.assign(this.data, values); if (done) done(); } };
}
function fakeWx(handler = () => {}, session) {
  const storage = new Map(session ? [[auth.SESSION_KEY, session]] : []);
  const requests = [], redirects = [], modals = [];
  let codes = 0;
  return {
    storage, requests, redirects, modals,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    login(options) { options.success({ code: `fresh-code-${++codes}` }); },
    request(options) { requests.push(options); handler(options); },
    redirectTo: ({url}) => redirects.push(url), navigateTo: ({url}) => redirects.push(url),
    showModal: options => modals.push(options), setNavigationBarTitle() {}
  };
}
const ok = (request, data) => request.success({ statusCode: 200, data });
const account = { id: 'u_new', role: 'member', status: 'active', canDownload: false, associationStatus: 'pending', albumReadScope: 'own-and-selected', albumReadProjectIds: [] };
const fields = { name: '张老师', contact: '13800000000', organization: '春风俱乐部', city: '', agreed: true };
const sessionResult = { token: 'onboard-token', user: account, loginMethod: 'wechat-miniapp', sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
const form = { applicantName: ' 张老师 ', applicantContact: ' 13800000000 ', applicantOrganization: ' 春风俱乐部 ', applicantCity: '', applicantAgreed: true };

// Break caught: a session-only result must lead directly to the new form, not another application button.
test('微信识别未绑定直接展示开通表，其他登录方式默认收起', async () => {
  global.wx = fakeWx(request => ok(request, { status: 'unbound' }));
  const page = pageAt('entry');
  assert.equal(page.data.showOtherLogin, false);
  page.setData({ wechatLoginAvailable: true });
  await page.onWechatRetry();
  assert.equal(page.data.showApply, true);
  assert.equal(page.data.authMode, 'onboard');
  assert.equal(auth.getSession(wx), null);
  page.onOtherLogin();
  assert.equal(page.data.showOtherLogin, true);
  assert.equal(page.data.showApply, false);
  assert.equal(wx.requests.length, 1);
});

test('首次开通直接进入普通工作台，只提交三个资料字段、可选城市和同意状态', async () => {
  global.wx = fakeWx(request => ok(request, sessionResult));
  const page = pageAt('entry');
  page.setData({ ...form, showApply: true, authMode: 'onboard', wechatStatus: 'unbound', wechatLoginAvailable: true });
  await page.onApply();
  assert.equal(wx.requests.length, 1, '开通表须调用新端点');
  assert.equal(wx.requests[0].url.endsWith('/auth/wechat/onboard'), true);
  assert.deepEqual(wx.requests[0].data, { code: 'fresh-code-1', ...fields });
  assert.equal(auth.getSession(wx).user.id, 'u_new');
  assert.deepEqual(wx.redirects, ['/pages/workbench/index']);
  assert.equal(auth.getSession(wx).user.canDownload, false);
});

test('精简资料表缺少俱乐部、姓名或联系方式长度不符不会请求开通', async () => {
  for (const [invalid, message] of [[{ applicantOrganization: '' }, /俱乐部/], [{ applicantName: '张' }, /姓名/], [{ applicantContact: '12345' }, /联系方式/], [{ applicantCity: '市'.repeat(81) }, /城市/]]) {
    global.wx = fakeWx(() => { throw new Error('invalid form must not request'); });
    const page = pageAt('entry');
    page.setData({ ...form, ...invalid, showApply: true, authMode: 'onboard', wechatStatus: 'unbound', wechatLoginAvailable: true });
    await page.onApply();
    assert.match(page.data.error, message);
    assert.equal(wx.requests.length, 0);
  }
});

test('待审、拒绝、撤销、停用和管理员状态均不能从新开通表绕过', async () => {
  for (const status of ['pending', 'rejected', 'revoked', 'disabled', 'password-required']) {
    global.wx = fakeWx(request => ok(request, { status }));
    const page = pageAt('entry');
    page.setData({ wechatLoginAvailable: true, ...form });
    await page.onWechatRetry();
    assert.equal(page.data.showApply, false);
    await page.onApply();
    assert.equal(wx.requests.length, 1);
    assert.equal(auth.getSession(wx), null);
  }
});

test('onboardWechat 始终取得新的真实微信 code，不透传伪造身份和权限', async () => {
  const wxApi = fakeWx(request => ok(request, sessionResult));
  assert.equal(typeof auth.onboardWechat, 'function');
  await auth.onboardWechat(wxApi, { ...fields, code: 'forged', userId: 'admin', role: 'admin', canDownload: true });
  await auth.onboardWechat(wxApi, fields);
  assert.deepEqual(wxApi.requests.map(row => row.data), [
    { ...fields, code: 'fresh-code-1' }, { ...fields, code: 'fresh-code-2' }
  ]);
  assert.equal(auth.getSession(wxApi).loginMethod, 'wechat-miniapp');
});

test('开通期间主动退出，晚到 token 被精确撤销而不恢复本机会话', async () => {
  let pending;
  const wxApi = fakeWx(request => request.url.endsWith('/onboard') ? pending = request : ok(request, {ok:true}));
  assert.equal(typeof auth.onboardWechat, 'function');
  const operation = auth.onboardWechat(wxApi, fields);
  await Promise.resolve();
  await auth.logout(wxApi);
  ok(pending, sessionResult);
  await assert.rejects(operation, error => error.cancelled);
  assert.equal(auth.getSession(wxApi), null);
  assert.equal(wxApi.storage.get(auth.MANUAL_LOGOUT_KEY), true);
  assert.equal(wxApi.requests.at(-1).header.Authorization, 'Bearer onboard-token');
});

test('旧开通响应不得覆盖期间新登录的原账号', async () => {
  let pending;
  const wxApi = fakeWx(request => request.url.endsWith('/onboard') ? pending = request : ok(request,
    request.url.endsWith('/login') ? { token: 'original-token', user: {id:'u_original',role:'operator'} } : {ok:true}));
  assert.equal(typeof auth.onboardWechat, 'function');
  const operation = auth.onboardWechat(wxApi, fields);
  await Promise.resolve();
  await auth.login(wxApi, 'original', 'secret');
  ok(pending, sessionResult);
  await assert.rejects(operation, error => error.cancelled);
  assert.equal(auth.getSession(wxApi).user.id, 'u_original');
  assert.equal(wxApi.requests.at(-1).header.Authorization, 'Bearer onboard-token');
});

test('开通接口不能保存服务端未支持的角色', async () => {
  const wxApi = fakeWx(request => ok(request, { ...sessionResult, user: { id: 'bad', role: 'root' } }));
  assert.equal(typeof auth.onboardWechat, 'function');
  await assert.rejects(auth.onboardWechat(wxApi, fields), /访问权限/);
  assert.equal(auth.getSession(wxApi), null);
});

test('开通中选择游客、取消或离开页面，晚到成功不能保存会话或跳转工作台', async () => {
  for (const action of ['onGuest', 'onCancelWechat', 'onUnload']) {
    let pending;
    global.wx = fakeWx(request => request.url.endsWith('/onboard') ? pending = request : ok(request, {ok:true}));
    const page = pageAt('entry');
    page.setData({ ...form, showApply: true, authMode: 'onboard', wechatStatus: 'unbound', wechatLoginAvailable: true });
    const operation = page.onApply();
    await Promise.resolve();
    page[action]();
    assert.ok(pending, '必须已请求新开通端点');
    ok(pending, sessionResult);
    await operation;
    assert.equal(auth.getSession(wx), null, action);
    assert.equal(wx.redirects.includes('/pages/workbench/index'), false, action);
    assert.deepEqual(wx.redirects, action === 'onGuest' ? ['/pages/workbench/index?guest=1'] : []);
  }
});

test('已绑定账号微信登录沿用原 id 和权限，不经过开通接口', async () => {
  global.wx = fakeWx(request => ok(request, { token:'existing', user: {id:'u_original',role:'operator',canDownload:true} }));
  const page = pageAt('entry'); page.setData({wechatLoginAvailable:true});
  await page.onWechatRetry();
  assert.equal(auth.getSession(wx).user.id, 'u_original');
  assert.equal(wx.requests.length, 1);
  assert.equal(wx.requests[0].url.endsWith('/auth/wechat/session'), true);
});

test('待关联 SOP 可点击获得说明，关联批准后现有会话复核即可下载', async () => {
  const current = {token:'existing',user:account,loginMethod:'password'};
  global.wx = fakeWx(request => ok(request, {user:{...account,canDownload:true,associationStatus:'approved'}}), current);
  const page = pageAt('catalog');
  page.type = 'activities'; page.id = 'act_001';
  page.setData({loggedIn:true,canDownloadSop:false,associationStatus:'pending',item:{id:'act_001'}});
  await page.onSopPdf();
  assert.equal(wx.modals[0].content, '资料下载需总部完成关联审核');
  assert.equal(wx.requests.length, 0);
  await page.onShow();
  assert.equal(page.data.canDownloadSop, true);
  assert.equal(page.data.associationStatus, 'approved');
  assert.equal(wx.requests[0].url.endsWith('/me'), true);
  const wxml = fs.readFileSync(require.resolve('../pages/catalog/index.wxml'), 'utf8');
  assert.match(wxml, /disabled="\{\{pdfBusy\}\}" bindtap="onSopPdf"/);
});

test('待关联案例下载由服务端拒绝，显示关联说明且不调用系统保存', async () => {
  global.wx = fakeWx(request => request.success({statusCode:403,data:{error:'资料下载需总部完成关联审核'}}), {token:'existing',user:account});
  const page = pageAt('catalog'); page.type='cases'; page.id='case_001';
  page.allMedia = [{index:0,type:'video',url:'https://apip2.opensplendid.com/silver-case-videos/test.mp4'}];
  page.setData({loggedIn:true});
  await page.onCaseSave({currentTarget:{dataset:{index:0}}});
  assert.equal(wx.modals[0].content, '资料下载需总部完成关联审核');
  assert.equal(page.data.savingIndex, -1);
  assert.equal(wx.requests.length, 1);
});

test('工作台使用已复核用户显示关联状态，普通用户仍保留本人相册入口', async () => {
  global.wx = fakeWx(request => ok(request, request.url.endsWith('/me') ? {user:account}
    : request.url.endsWith('/my/activity-projects') ? {projects:[],canCreate:true} : {activities:[],cases:[]}),
    {token:'existing',user:account});
  const page = pageAt('workbench'); await page.load();
  assert.equal(page.data.user.associationStatus, 'pending');
  assert.equal(page.data.associationMessage, '总部关联中：可管理自己的相册、上传和分享；资料下载需总部完成关联审核。');
  assert.equal(page.data.canCreateProjects, true);
});

test('资料验证请求晚到不能把总部已批准的下载权限覆盖为旧待关联状态', async () => {
  let content;
  global.wx = fakeWx(request => request.url.endsWith('/me')
    ? ok(request, {user:{...account,canDownload:true,associationStatus:'approved'}}) : content = request,
    {token:'existing',user:account});
  const page = pageAt('catalog'); page.type='activities'; page.id='act_001';
  const loading = page.load();
  await page.onShow();
  ok(content, {activity:{id:'act_001',title:'活动',plan:{}}});
  await loading;
  assert.equal(page.data.canDownloadSop, true);
  assert.equal(page.data.associationStatus, 'approved');
});

test('开通获取微信凭证期间取消，不再向服务器提交新账户', async () => {
  let code;
  const wxApi = fakeWx(() => { throw new Error('cancelled operation must not request'); });
  wxApi.login = options => { code = options; };
  const operation = auth.onboardWechat(wxApi, fields);
  auth.cancelSessionValidation(wxApi);
  code.success({code:'late-real-code'});
  await assert.rejects(operation, error => error.cancelled);
  assert.equal(wxApi.requests.length, 0);
  assert.equal(auth.getSession(wxApi), null);
});

test('微信会话续验更换 token 时，详情重新使用新会话请求并结束加载', async () => {
  const pending = [];
  const old = { token:'old-token', user:account, loginMethod:'wechat-miniapp', sessionExpiresAt:new Date(Date.now()+3600000).toISOString() };
  global.wx = fakeWx(request => {
    if (request.url.endsWith('/me')) return ok(request, {user:{...account,canDownload:true,associationStatus:'approved'},loginMethod:'wechat-miniapp',sessionExpiresAt:old.sessionExpiresAt});
    if (request.url.endsWith('/auth/wechat/session')) return ok(request, {token:'renewed-token',user:{...account,canDownload:true,associationStatus:'approved'},loginMethod:'wechat-miniapp',sessionExpiresAt:'2099-01-01T00:00:00.000Z'});
    pending.push(request);
  }, old);
  const page = pageAt('catalog'); page.type='activities'; page.id='act_001';
  const loading = page.load();
  await page.onShow();
  assert.equal(auth.getSession(wx).token, 'renewed-token');
  ok(pending[0], {activity:{id:'act_001',title:'旧会话内容',plan:{target:'旧权限内容'}}});
  await Promise.resolve();
  assert.equal(pending.length, 2, '旧 token 响应后须使用现有 token 重取内容');
  assert.equal(pending[1].header.Authorization, 'Bearer renewed-token');
  ok(pending[1], {activity:{id:'act_001',title:'续验后的内容',plan:{target:'现有权限内容'}}});
  await loading;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.item.title, '续验后的内容');
  assert.equal(page.data.planSections[0].content, '现有权限内容');
  assert.equal(page.data.canDownloadSop, true);
});

test('旧账户详情晚到时使用新账户重新请求，不能显示旧账户方案', async () => {
  const pending=[];
  global.wx=fakeWx(request=>pending.push(request), {token:'old-token',user:account});
  const page=pageAt('catalog'); page.type='activities'; page.id='act_001';
  const loading=page.load();
  wx.storage.set(auth.SESSION_KEY, {token:'other-token',user:{id:'u_other',role:'viewer',canDownload:false}});
  ok(pending[0], {activity:{id:'act_001',title:'旧用户受限内容',plan:{target:'旧账号内容'}}});
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(pending[1].header.Authorization, 'Bearer other-token');
  assert.equal(page.data.item, null);
  ok(pending[1], {activity:{id:'act_001',title:'新用户内容',planLocked:true}});
  await loading;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.item.title,'新用户内容');
  assert.deepEqual(page.data.planSections,[]);
});

test('退出期间晚到的详情错误不能挂住页面，匿名重取不显示受限方案', async () => {
  const pending=[];
  global.wx=fakeWx(request => request.url.endsWith('/logout') ? ok(request,{ok:true}) : pending.push(request), {token:'old-token',user:account});
  const page=pageAt('catalog'); page.type='activities'; page.id='act_001';
  const loading=page.load();
  await auth.logout(wx);
  pending[0].success({statusCode:403,data:{error:'旧 token 已撤销'}});
  await Promise.resolve();
  assert.equal(pending.length,2);
  assert.equal(pending[1].header.Authorization,undefined);
  ok(pending[1],{activity:{id:'act_001',title:'公开内容',planLocked:true}});
  await loading;
  assert.equal(page.data.loading,false);
  assert.equal(page.data.loggedIn,false);
  assert.equal(page.data.item.title,'公开内容');
  assert.deepEqual(page.data.planSections,[]);
  assert.equal(page.data.error,'');
});

test('先发的详情或失败晚于新请求返回，均不能覆盖新页面内容和状态', async () => {
  for(const failed of [false,true]) {
    const pending=[];
    global.wx=fakeWx(request=>pending.push(request),{token:'current',user:account});
    const page=pageAt('catalog'); page.type='activities'; page.id='act_old';
    const oldLoading=page.load();
    page.id='act_new';
    const newLoading=page.load();
    ok(pending[1],{activity:{id:'act_new',title:'新详情',plan:{target:'新详情内容'}}});
    await newLoading;
    if(failed) pending[0].success({statusCode:403,data:{error:'旧请求错误'}});
    else ok(pending[0],{activity:{id:'act_old',title:'旧详情',plan:{target:'旧详情内容'}}});
    await oldLoading;
    assert.equal(page.data.item.id,'act_new');
    assert.equal(page.data.planSections[0].content,'新详情内容');
    assert.equal(page.data.loading,false);
    assert.equal(page.data.error,'');
    assert.equal(pending.length,2);
  }
});
