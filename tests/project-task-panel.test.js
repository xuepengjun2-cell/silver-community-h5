const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = [process.env.SILVER_UI_SOURCE, path.join(__dirname, 'live/public/app.js'), path.join(__dirname, '../public/app.js')].filter(Boolean).find(file => fs.existsSync(file));
assert.ok(sourcePath, 'frontend source path exists');
const source = fs.readFileSync(sourcePath, 'utf8');

function extract(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, 'function exists: ' + name);
  const tail = source.slice(match.index + 1);
  const next = /\n(?:async )?function [A-Za-z_$]/.exec(tail);
  return source.slice(match.index, next ? match.index + 1 + next.index : undefined);
}

function context(names, overrides = {}) {
  const state = { projectUploadSessions: [], projectUploadSessionsError: '', projectUploadTaskMessages: {}, projectUploadTaskActions: {}, projectUploading: false, projectView: 'manager', currentProject: {id: 'p'}, projectUploadTransfer: null, projectUploadBatchNotice: null };
  const ctx = vm.createContext({ state, console, AbortController, setTimeout, clearTimeout,
    projectUploadControllers: new Map(), PROJECT_VIDEO_UPLOAD_WORKERS: 3,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    ...overrides });
  vm.runInContext([extract('esc'), ...names.map(extract)].join('\n'), ctx);
  return ctx;
}

test('progress is measured and clamped; unknown progress stays indeterminate', () => {
  const ctx = context(['projectTaskProgressHtml']);
  assert.match(ctx.projectTaskProgressHtml({percent:45.5,label:'转换'}), /value="45.5"/);
  assert.match(ctx.projectTaskProgressHtml({percent:120}), /value="100"/);
  assert.match(ctx.projectTaskProgressHtml({percent:-3}), /value="0"/);
  const unknown = ctx.projectTaskProgressHtml({percent:null});
  assert.match(unknown, /is-indeterminate/);
  assert.doesNotMatch(unknown, /value=/);
  assert.doesNotMatch(ctx.projectTaskProgressHtml({percent:NaN}), /value=/);
  assert.equal(ctx.projectTaskProgressHtml(null, false), '');
});

test('task panel hides completed and dismissed work, keeps error details collapsed and escaped', () => {
  const ctx = context(['projectTaskProgressHtml', 'projectUploadSessionsHtml']);
  ctx.state.projectUploadSessions = [
    {sessionId:'a',status:'completed',title:'finished-name'},
    {sessionId:'b',status:'dismissed',title:'dismissed-name'},
    {sessionId:'c',status:'aborted',title:'aborted-name'},
    {sessionId:'d',status:'queued',title:'queued-name'},
    {sessionId:'e',status:'delivery_failed',title:'retry-name',error:'bad <script>secret</script>'}
  ];
  const html = ctx.projectUploadSessionsHtml('p');
  for (const hidden of ['finished-name','dismissed-name','aborted-name']) assert.doesNotMatch(html,new RegExp(hidden));
  assert.match(html,/排队等待转换/);
  assert.match(html,/data-project-task-action="pause"/);
  assert.match(html,/data-project-task-action="resume"/);
  assert.match(html,/删除任务/);
  assert.match(html,/<details class="project-task-details"><summary>查看处理详情<\/summary>/);
  assert.doesNotMatch(html,/<details[^>]* open/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/&lt;script&gt;/);
});

test('publishing disables stop and delete and shows an honest saving message', () => {
  const ctx=context(['projectTaskProgressHtml','projectUploadSessionsHtml']);
  ctx.state.projectUploadSessions=[{sessionId:'x',title:'video',status:'processing',progress:{stage:'publishing',label:'保存结果',percent:null}}];
  const html=ctx.projectUploadSessionsHtml('p');
  assert.match(html,/data-project-task-action="pause"[^>]* disabled/);
  assert.match(html,/data-project-task-action="dismiss"[^>]* disabled/);
  assert.match(html,/正在保存结果/);
});

test('upload progress does not claim conversion has completed at 100%', () => {
  const ctx=context(['projectTaskProgressHtml','projectUploadProgressHtml']);
  ctx.state.projectUploadTransfer={projectId:'p',name:'video <x>',type:'video',index:1,total:2,percent:100};
  const html=ctx.projectUploadProgressHtml('p');
  assert.match(html,/value="100"/);
  assert.match(html,/上传到 100% 后，视频将自动进入后台转换/);
  assert.match(html,/video &lt;x&gt;/);
  assert.doesNotMatch(html,/转换已完成/);
  assert.equal(ctx.projectUploadProgressHtml('other'), '');
});

test('poll queued work every four seconds, partial uploads more slowly, and stop polling paused work', () => {
  const timers=[];
  const ctx=context(['scheduleProjectUploadPoll'],{projectUploadPollTimer:null,setTimeout:(fn,delay)=>{timers.push(delay);return 1;},clearTimeout:()=>{}});
  ctx.state.projectUploadSessions=[{status:'queued'}];ctx.scheduleProjectUploadPoll('p');
  ctx.state.projectUploadSessions=[{status:'uploading'}];ctx.scheduleProjectUploadPoll('p');
  ctx.state.projectUploadSessions=[{status:'paused'}];ctx.scheduleProjectUploadPoll('p');
  ctx.state.projectUploadSessions=[];ctx.state.projectUploadSessionsError='offline';ctx.scheduleProjectUploadPoll('p');
  assert.deepEqual(timers,[4000,12000,15000]);
});

test('queued-to-completed refreshes album media, not just processing-to-completed', async () => {
  const loaded=[];
  const ctx=context(['refreshProjectUploadSessions'],{api:async()=>({sessions:[{sessionId:'q',status:'completed'}]}),syncProjectUploadControls:()=>{},loadProjectManager:id=>loaded.push(id)});
  ctx.state.projectUploadSessions=[{sessionId:'q',status:'queued'}];
  await ctx.refreshProjectUploadSessions('p');
  assert.deepEqual(loaded,['p']);
});

function actionContext(action, result, {accepted=true,reject=false}={}) {
  let listener;
  const calls=[];
  const button={dataset:{projectTaskAction:action,projectTaskId:'session'},addEventListener:(_,fn)=>listener=fn};
  const ctx=context(['bindProjectUploadSessionActions'],{
    document:{querySelectorAll:selector=>selector==='[data-project-task-action]'?[button]:[]},
    confirm:question=>{calls.push({question});return accepted;},
    api:async(url)=>{calls.push({url});if(reject)throw Error('正在保存结果，请稍候');return result;},
    syncProjectUploadPanel:()=>{},refreshProjectUploadSessions:async()=>{},
    alert:()=>{throw Error('blocking alert must not run');}
  });
  ctx.bindProjectUploadSessionActions('p');
  return {ctx,calls,run:()=>listener()};
}

test('pause aborts browser PUTs and calls only the pause endpoint, with no blocking alert', async () => {
  const a=actionContext('pause',{status:'paused'}),controller=new AbortController();
  a.ctx.projectUploadControllers.set('session',controller);
  await a.run();
  assert.equal(controller.signal.aborted,true);
  assert.match(a.calls.find(c=>c.url).url,/\/session\/pause$/);
  assert.match(a.ctx.state.projectUploadTaskMessages.session,/已停止/);
  assert.equal(a.ctx.state.projectUploadTaskActions.session,undefined);
});

test('delete asks explicit task-only confirmation and cancel never sends a mutation', async () => {
  const a=actionContext('dismiss',{}, {accepted:false});
  await a.run();
  assert.match(a.calls[0].question,/不会删除原视频或已发布的相册素材/);
  assert.equal(a.calls.some(c=>c.url),false);
});

test('task-action refusal is shown inline and action lock is released', async () => {
  const a=actionContext('pause',{}, {reject:true});
  await a.run();
  assert.match(a.ctx.state.projectUploadTaskMessages.session,/正在保存结果/);
  assert.equal(a.ctx.state.projectUploadTaskActions.session,undefined);
});

test('resume partial upload tells user to select the same original, without pretending it is queued', async () => {
  const a=actionContext('resume',{status:'uploading'});
  await a.run();
  assert.match(a.calls.find(c=>c.url).url,/\/session\/resume$/);
  assert.match(a.ctx.state.projectUploadTaskMessages.session,/请选择同一原文件/);
});

test('pausing a transfer retains multipart resume state and never submits completion', async () => {
  const saved=[],calls=[];
  const ctx=context(['projectUploadPausedError','uploadProjectVideoMultipart'],{
    readProjectUploadState:()=>null,projectUploadStateKey:()=> 'saved-key',
    writeProjectUploadState:(key,value)=>saved.push({key,value}),clearProjectUploadState:()=>assert.fail('must retain resume state'),
    api:async(url)=>{calls.push(url);return {sessionId:'s',partSize:10,partCount:1};},
    syncProjectUploadPanel:()=>{},
  });
  ctx.state.projectView='other';
  const file={name:'video.mp4',size:10,lastModified:1,slice:()=>new Uint8Array(10)};
  await assert.rejects(ctx.uploadProjectVideoMultipart('p',file,()=>ctx.projectUploadControllers.get('s').abort()),e=>e.code==='UPLOAD_PAUSED');
  assert.ok(saved.length>=2);
  assert.equal(calls.some(url=>url.includes('/complete')),false);
  assert.equal(ctx.projectUploadControllers.has('s'),false);
});
