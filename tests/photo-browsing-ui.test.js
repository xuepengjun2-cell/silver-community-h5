const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8');
function fixture() {
  const timers=[], images=[], requests=[], handlers={}; let now=1000;
  class Image { constructor(){images.push(this);} }
  const app={innerHTML:'',className:''};
  const document={querySelector:s=>s==='#app'?app:null,querySelectorAll:()=>[],addEventListener:(n,f)=>handlers[n]=f};
  const ctx=vm.createContext({console, URL, URLSearchParams, Map, Set, Image, document, navigator:{userAgent:'Desktop',connection:{}},localStorage:{getItem:()=>null},location:{search:'',origin:'https://example.com'},history:{pushState(){},replaceState(){}},window:{location:{origin:'https://example.com'},addEventListener:(n,f)=>handlers[n]=f},setTimeout:(fn,delay)=>{const t={fn,delay};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;},Date:class extends Date {static now(){return now;}},fetch:async()=>{throw Error('unexpected fetch');}});
  vm.runInContext(source.replace(/^boot\(\);?$/m,''),ctx);
  vm.runInContext('globalThis.state=state;globalThis.app=app;',ctx);
  ctx.api=async endpoint=>{requests.push(endpoint);return {project:project()};};
  ctx.trackMediaView=()=>{}; ctx.projectHeader=()=>'';ctx.projectWeChatTip=()=>'';ctx.loginModal=()=>'';ctx.bindAuthEvents=()=>{};ctx.bindProjectShareEvents=()=>{};
  return {ctx,app,timers,images,requests,handlers,advance:n=>now+=n};
}
const original='https://proj2.likeduoduiyi.cn/silver-project-images/a.jpg';
const photo=(url=original)=>({type:'image',url,size:4000});
const project=()=>({id:'p',title:'Test',status:'published',shareEnabled:true,media:[photo(),photo(original.replace('a.jpg','b.jpg'))]});
// A wrong source tier would transfer the original in every card.
test('cards use 640, previews use 1600 and original mode leaves source identity intact',()=>{
 const {ctx,app}=fixture(),p=project();
 assert.match(ctx.projectMediaCardHtml(p,{...p.media[0],index:0}),/w_640/);
 ctx.renderProjectPreview(p,0); assert.match(app.innerHTML,/w_1600/);assert.equal(p.media[0].url,original);
 assert.match(app.innerHTML,/查看原图/);
});
test('large pending and unavailable images never silently load originals; GIF and unknown stay compatible',()=>{
 const {ctx,app}=fixture(),p=project();p.media[0]={...photo(),size:22*1024*1024,imageViewState:'pending'};
 ctx.renderProjectPreview(p,0);assert.doesNotMatch(app.innerHTML,/<img[^>]+src="https:\/\/proj2[^\"]+a.jpg"/);assert.match(app.innerHTML,/准备中/);
 for(const url of ['https://foreign.example/a.jpg',original.replace('.jpg','.gif'),original.replace('.jpg','.svg')])assert.equal(ctx.photoSource(photo(url),'preview'),url);
 assert.equal(ctx.photoSource({...photo(),size:0},'preview'),'');
});
test('direct entry verifies, session navigation caches for at most 15 seconds, scopes and actors isolate',async()=>{
 const f=fixture(); await f.ctx.loadProjectPreview('p',0);await f.ctx.loadProjectPreview('p',1,false,{session:true});assert.equal(f.requests.length,1);
 f.advance(15001);await f.ctx.loadProjectPreview('p',0,false,{session:true});assert.equal(f.requests.length,2);
 await f.ctx.loadProjectPreview('p',0);assert.equal(f.requests.length,3);
 f.ctx.state.user={id:'other'};await f.ctx.loadProjectPreview('p',0,false,{session:true});assert.equal(f.requests.length,4);
 await f.ctx.loadProjectPreview('p',0,true,{session:true});assert.match(f.requests.at(-1),/\/my\//);
});
test('revalidation remaps desired original URL after reorder and refuses removed photos',async()=>{
 const f=fixture(),p=project();await f.ctx.loadProjectPreview('p',0);f.advance(15001);
 f.ctx.api=async()=>({project:{...p,media:[p.media[1],p.media[0]]}});
 await f.ctx.loadProjectPreview('p',0,false,{session:true,expectedUrl:original});assert.equal(f.ctx.state.projectPreviewIndex,1);
 f.ctx.api=async()=>({project:{...p,media:[p.media[1]]}});f.advance(15001);
 await f.ctx.loadProjectPreview('p',1,false,{session:true,expectedUrl:original});assert.match(f.app.innerHTML,/已移除/);assert.doesNotMatch(f.app.innerHTML,/project-preview-image/);
});
test('late responses and expired denied/offline responses cannot retain a usable preview',async()=>{
 const f=fixture();let resolve;
 f.ctx.api=()=>new Promise(r=>resolve=r);const slow=f.ctx.loadProjectPreview('p',0);
 f.ctx.api=async()=>({project:project()});await f.ctx.loadProjectPreview('p',1);resolve({project:project()});await slow;assert.equal(f.ctx.state.projectPreviewIndex,1);
 f.advance(15001);f.ctx.api=async()=>{throw Error('403 share closed');};await f.ctx.loadProjectPreview('p',0,false,{session:true});assert.match(f.app.innerHTML,/403/);assert.doesNotMatch(f.app.innerHTML,/project-preview-image/);
 f.ctx.api=async()=>{throw Error('offline');};await f.ctx.loadProjectPreview('p',0,false,{session:true});assert.match(f.app.innerHTML,/offline/);
});
test('image load prefetches only one derived next preview, skips slow networks, and cleans up',()=>{
 const f=fixture(),p=project(),node={dataset:{},src:'',addEventListener(){}};
 f.ctx.document.querySelectorAll=selector=>selector==='[data-photo-image]'?[node]:[];
 f.ctx.renderProjectPreview(p,0);assert.equal(f.images.length,0);node.onload();assert.equal(f.images.length,1);assert.match(f.images[0].src,/w_1600/);
 node.onload();assert.equal(f.images.length,1);f.ctx.clearPhotoView();assert.equal(f.images[0].src,'');assert.equal(f.images[0].onload,null);
 f.ctx.navigator.connection.saveData=true;f.ctx.renderProjectPreview(p,0);node.onload();assert.equal(f.images.length,1);
});
test('bounded fallback never transfers large original and pending polling stops on exit',()=>{
 const f=fixture(),p=project(),node={dataset:{},src:'',addEventListener(){},removeAttribute(){this.src='';}};
 p.media[0]={...photo(),size:30e6,imageViewState:'ready',thumbnailUrl:'https://example.com/thumb.jpg',previewUrl:'https://example.com/preview.jpg'};
 f.ctx.document.querySelectorAll=s=>s==='[data-photo-image]'?[node]:[];
 f.ctx.renderProjectPreview(p,0);node.onerror();assert.equal(node.src,'https://example.com/thumb.jpg');node.onerror();assert.equal(node.src,'');assert.equal(node.onerror,null);
 p.media[0].imageViewState='pending';delete p.media[0].previewUrl;delete p.media[0].thumbnailUrl;f.ctx.renderProjectPreview(p,0);
 assert.ok(f.timers.some(t=>t.delay===2000&&!t.cancelled));f.ctx.clearPhotoView();assert.ok(f.timers.filter(t=>t.delay===2000).every(t=>t.cancelled));
});
test('mobile image download remains explicit and uses the visible original identity guard',async()=>{
 const f=fixture(),p=project();f.ctx.navigator.userAgent='iPhone';assert.match(f.ctx.projectDownloadButton(p,0),/data-project-download/);
 const button={dataset:{projectDownload:'0'},addEventListener:(event,fn)=>button.click=fn};const root={querySelectorAll:s=>s==='[data-project-download]'?[button]:[]};let endpoint;
 f.ctx.api=async url=>{endpoint=url;return {};};f.ctx.bindProjectDownloadEvents(p,root);await button.click();assert.equal(new URL(endpoint,'https://example.com').searchParams.get('expectedUrl'),original);
 assert.match(f.ctx.projectMobileMediaTip(p,0),/浏览图/);assert.match(f.ctx.projectMobileMediaTip(p,0),/原图/);
});
test('focus clears active transfer before rechecking and permission expiry clears immediately',async()=>{
 const f=fixture();await f.ctx.loadProjectPreview('p',0);let resolve;
 f.ctx.api=()=>new Promise(r=>resolve=r);f.handlers.focus();assert.match(f.app.innerHTML,/核验/);assert.doesNotMatch(f.app.innerHTML,/project-preview-image/);
 resolve({project:project()});await new Promise(r=>setImmediate(r));
 const expiry=f.timers.filter(t=>!t.cancelled&&t.delay===15000).at(-1);assert.ok(expiry);f.advance(15000);expiry.fn();assert.match(f.app.innerHTML,/核验/);
});
test('returning to album defeats a late preview request',async()=>{
 const f=fixture();let resolve;f.ctx.api=()=>new Promise(r=>resolve=r);const opening=f.ctx.loadProjectPreview('p',0);
 f.ctx.api=async()=>({project:project()});f.ctx.renderProjectAlbum=()=>{f.ctx.app.innerHTML='album';};await f.ctx.loadPublicProject('p');resolve({project:project()});await opening;assert.equal(f.app.innerHTML,'album');
});
test('original toggle only changes the display, retaining original download and returning to preview',()=>{
 const f=fixture(),p=project(),button={addEventListener:(e,fn)=>button.click=fn};
 f.ctx.document.querySelector=s=>s==='[data-photo-original-toggle]'?button:null;
 f.ctx.rememberPhotoProject(p,false);f.ctx.renderProjectPreview(p,0);button.click();assert.match(f.app.innerHTML,/<img[^>]+src="https:\/\/proj2.likeduoduiyi.cn\/silver-project-images\/a.jpg"/);
 assert.match(f.app.innerHTML,/返回清晰预览/);assert.equal(p.media[0].url,original);button.click();assert.match(f.app.innerHTML,/w_1600/);
});
test('pending polls stop after30seconds and stale callback cannot reopen an exited preview',async()=>{
 const f=fixture(),p=project();p.media[0]={...photo(),size:30e6,imageViewState:'pending'};f.ctx.api=async()=>({project:p});
 await f.ctx.loadProjectPreview('p',0);const poll=f.timers.find(t=>t.delay===2000&&!t.cancelled);assert.ok(poll);
 f.advance(30000);await poll.fn();await new Promise(r=>setImmediate(r));assert.equal(f.timers.filter(t=>t.delay===2000&&!t.cancelled).length,0);
 f.ctx.clearPhotoView();f.ctx.state.projectView='album';const before=f.app.innerHTML;await poll.fn();assert.equal(f.app.innerHTML,before);
});
test('case download login gate and iOS WeChat video save remain intact',()=>{
 const f=fixture();assert.match(f.ctx.caseDownloadAction('c',{...photo(),index:0}),/data-case-login/);assert.doesNotMatch(f.ctx.caseDownloadAction('c',{...photo(),index:0}),/data-case-download/);
 f.ctx.state.user={id:'u'};assert.match(f.ctx.caseDownloadAction('c',{...photo(),index:0}),/data-case-download/);
 f.ctx.navigator.userAgent='iPhone MicroMessenger';const p={...project(),media:[{type:'video',url:'https://example.com/video.mp4'}]};assert.match(f.ctx.projectDownloadButton(p,0),/data-project-save-video/);assert.match(f.ctx.projectMobileMediaTip(p,0),/Safari/);
});
test('login refreshes a preview from server instead of rendering old account metadata',async()=>{
 const f=fixture(),p=project();let submit;f.ctx.state.currentProject=p;f.ctx.state.projectView='preview';f.ctx.state.projectPreviewIndex=0;
 f.ctx.FormData=class {get(){return 'x';}};f.ctx.document.querySelector=s=>s==='#loginForm'?{addEventListener:(e,fn)=>submit=fn}:null;
 f.ctx.api=async endpoint=>endpoint==='/api/login'?{user:{id:'new'}}:{project:p};
 vm.runInContext('bindAuthEvents = '+source.match(/function bindAuthEvents\(\) \{[\s\S]*?(?=\nfunction )/)[0],f.ctx);
 let reverified=0;f.ctx.loadProjectPreview=async()=>reverified++;f.ctx.renderProjectPreview=()=>{throw Error('reused old account metadata');};f.ctx.bindAuthEvents();await submit({preventDefault(){},currentTarget:{}});assert.equal(reverified,1);
});
test('late load events cannot start old prefetch and expired original toggle must reverify',async()=>{
 const f=fixture(),p=project(),node={dataset:{},src:'',removeAttribute(){this.src='';}},button={addEventListener:(e,fn)=>button.click=fn};
 f.ctx.document.querySelectorAll=s=>s==='[data-photo-image]'?[node]:[];f.ctx.document.querySelector=s=>s==='[data-photo-original-toggle]'?button:null;
 await f.ctx.loadProjectPreview('p',0);const loaded=node.onload;f.ctx.invalidatePhotoBrowsing();loaded();assert.equal(f.images.length,0);
 await f.ctx.loadProjectPreview('p',0);f.advance(15001);let resolve;f.ctx.api=()=>new Promise(r=>resolve=r);button.click();assert.match(f.app.innerHTML,/核验/);assert.doesNotMatch(f.app.innerHTML,/project-preview-image/);resolve({project:p});
});
test('late manager response cannot replace the active preview metadata',async()=>{
 const f=fixture();f.ctx.state.user={id:'u'};let resolve;f.ctx.projectUploadControl=()=>new Promise(r=>resolve=r);
 const loading=f.ctx.loadProjectManager('old');await f.ctx.loadProjectPreview('p',0);resolve({project:{...project(),id:'old'}});await loading;assert.equal(f.ctx.state.currentProject.id,'p');assert.equal(f.ctx.state.projectView,'preview');
});
test('late manager failure cannot replace another project preview or cross account boundaries',async()=>{
 for (const changeActor of [false,true]) {
  const f=fixture();f.ctx.state.user={id:'u'};let reject;f.ctx.projectUploadControl=()=>new Promise((resolve,no)=>reject=no);
  const loading=f.ctx.loadProjectManager('old');
  if(changeActor) {f.app.innerHTML='new account view';f.ctx.state.user={id:'other'};}
  else await f.ctx.loadProjectPreview('p',0);
  const displayed=f.app.innerHTML;reject(Error('OLD MANAGER FAILED'));await loading;
  assert.equal(f.app.innerHTML,displayed);assert.doesNotMatch(f.app.innerHTML,/OLD MANAGER FAILED/);
  if(!changeActor)assert.equal(f.ctx.state.currentProject.id,'p');
 }
});
test('cover pending never emits an empty image URL; legacy animations and unsafe paths are unchanged',()=>{
 const f=fixture(),p=project();p.cover=original;p.media[0]={...photo(),size:30e6,imageViewState:'pending'};
 assert.ok(f.ctx.caseCoverUrl(p));assert.match(f.ctx.photoCoverHtml(p),/准备中/);
 for(const url of [original.replace('.jpg','.webp'),original.replace('proj2.likeduoduiyi.cn','evil.example'),original+'?signed=x',original.replace('/silver-project-images/','/other/')])assert.equal(f.ctx.photoSource(photo(url),'thumbnail'),url);
});
test('expired preview cannot be revived by login modal rerender, and focused album is reverified',async()=>{
 const f=fixture();await f.ctx.loadProjectPreview('p',0);f.advance(15001);let resolve;f.ctx.api=()=>new Promise(r=>resolve=r);f.ctx.rerenderCurrent();assert.match(f.app.innerHTML,/核验/);resolve({project:project()});await new Promise(r=>setImmediate(r));
 f.ctx.state.projectView='album';let loads=0;f.ctx.loadPublicProject=async()=>{loads++;};f.handlers.focus();assert.equal(loads,1);
});
test('case detail image cards use lazy1600 while retaining the original login-gated download identity',()=>{
 const f=fixture(),c=project();f.ctx.document.querySelector=s=>s==='#caseBackList'?{addEventListener(){}}:null;f.ctx.state.cases=[c];f.ctx.renderCasePage('p');
 assert.match(f.app.innerHTML,/<img[^>]*data-case-image-view="0"[^>]*w_1600[^>]*loading="lazy"/);assert.match(f.app.innerHTML,/data-case-login/);assert.equal(c.media[0].url,original);
});
test('delayed album focus rejection cannot erase a newer preview or account',async()=>{
 for(const changeActor of [false,true]){
  const f=fixture();f.ctx.state.currentProject=project();f.ctx.state.projectView='album';let reject;
  f.ctx.api=()=>new Promise((yes,no)=>reject=no);f.handlers.focus();
  if(changeActor){f.ctx.state.user={id:'new'};f.app.innerHTML='new account';}else{f.ctx.api=async()=>({project:project()});await f.ctx.loadProjectPreview('p',1);}
  const before=f.app.innerHTML;reject(Error('old focus failure'));await new Promise(r=>setImmediate(r));assert.equal(f.app.innerHTML,before);assert.ok(f.ctx.state.currentProject);
 }
});
test('case pending refresh becomes lazy preview; unavailable allows original independent of download login',async()=>{
 const f=fixture(),c=project();c.media=[{...photo(),size:30e6,imageViewState:'pending'}];
 const button={dataset:{casePhotoOriginal:'0'},addEventListener:(_e,fn)=>button.click=fn};
 f.ctx.document.querySelector=s=>s==='#caseBackList'?{addEventListener(){}}:null;
 f.ctx.document.querySelectorAll=s=>s==='[data-case-photo-original]'?[button]:[];
 f.ctx.state.cases=[c];f.ctx.renderCasePage('p');assert.match(f.app.innerHTML,/data-case-photo-original="0"/);assert.match(f.app.innerHTML,/data-case-login/);
 const poll=f.timers.find(t=>t.delay===2000&&!t.cancelled);assert.ok(poll);
 f.ctx.api=async()=>({cases:[{...c,media:[{...c.media[0],imageViewState:'ready',previewUrl:'https://example.com/1600.jpg'}]}]});await poll.fn();
 assert.match(f.app.innerHTML,/<img[^>]+1600.jpg[^>]+loading="lazy"/);
 f.ctx.state.cases=[{...c,media:[{...c.media[0],imageViewState:'unavailable'}]}];f.ctx.renderCasePage('p');button.click();assert.match(f.app.innerHTML,/<img[^>]+src="https:\/\/proj2.likeduoduiyi.cn\/silver-project-images\/a.jpg"/);assert.match(f.app.innerHTML,/data-case-login/);
});
test('case readiness poll is bounded and navigation cancels stale responses',async()=>{
 const f=fixture(),c=project();c.media=[{...photo(),size:30e6,imageViewState:'pending'}];f.ctx.document.querySelector=s=>s==='#caseBackList'?{addEventListener(){}}:null;f.ctx.state.cases=[c];f.ctx.renderCasePage('p');
 const poll=f.timers.find(t=>t.delay===2000&&!t.cancelled);assert.ok(poll);let resolve;f.ctx.api=()=>new Promise(r=>resolve=r);const pending=poll.fn();f.ctx.renderCases();const before=f.app.innerHTML;resolve({cases:[c]});await pending;assert.equal(f.app.innerHTML,before);assert.ok(poll.cancelled);
 f.ctx.renderCasePage('p');f.advance(30000);const next=f.timers.filter(t=>t.delay===2000&&!t.cancelled).at(-1);let requests=0;f.ctx.api=async()=>{requests++;return {cases:[c]};};await next.fn();assert.equal(requests,0);
});
test('animated WebP service DTO displays original with zero derived uploads',async t=>{
 const os=require('node:os'),path=require('node:path'),{createPhotoViews}=require('../server/photo-views');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'animated-browser-'));let uploads=0;
 const bytes=fs.readFileSync(path.join(__dirname,'fixtures/photo-views/animated.webp')),url=original.replace('.jpg','.webp'),media={type:'image',url,size:bytes.length};
 const service=createPhotoViews({stateFile:path.join(dir,'state.json'),stagingRoot:path.join(dir,'stage'),resolveSource:m=>({key:'photos/a.webp',url:m.url}),isReferenced:()=>true,canRun:async()=>true,io:{head:async()=>({size:bytes.length,etag:'animation'}),download:async(_key,file)=>fs.writeFileSync(file,bytes),upload:async()=>uploads++}});
 t.after(async()=>{await service.stop();fs.rmSync(dir,{recursive:true,force:true});});service.request(media);
 for(let i=0;i<100&&service.decorate(media).imageViewState==='pending';i++)await new Promise(r=>setTimeout(r,10));
 const dto=service.decorate(media),f=fixture();assert.equal(f.ctx.photoSource(dto,'preview'),url);assert.equal(uploads,0);
});
test('case focus retains case context and resumes readiness checks instead of reopening an old album',()=>{
 const f=fixture(),c=project();c.media=[{...photo(),size:30e6,imageViewState:'pending'}];f.ctx.document.querySelector=s=>s==='#caseBackList'?{addEventListener(){}}:null;f.ctx.state.cases=[c];f.ctx.state.currentProject=project();f.ctx.state.projectView='album';f.ctx.renderCasePage('p');
 let albums=0;f.ctx.loadPublicProject=()=>albums++;f.handlers.focus();assert.equal(albums,0);assert.ok(f.timers.some(t=>t.delay===2000&&!t.cancelled));assert.match(f.app.innerHTML,/case-media-card/);
});
test('case to project preview via loader or popstate keeps project on focus',async()=>{
 for(const popstate of [false,true]) {
  const f=fixture();f.ctx.document.querySelector=s=>s==='#caseBackList'?{addEventListener(){}}:null;f.ctx.state.cases=[project()];f.ctx.renderCasePage('p');
  if(popstate){f.ctx.location.search='?view=project-preview&project=p&media=1';f.handlers.popstate();await new Promise(r=>setImmediate(r));}else await f.ctx.loadProjectPreview('p',1);
  assert.equal(f.ctx.state.caseView,false);assert.equal(f.ctx.state.activeCaseId,'');f.handlers.focus();await new Promise(r=>setImmediate(r));assert.match(f.app.innerHTML,/project-preview-image/);assert.doesNotMatch(f.app.innerHTML,/case-media-card/);
 }
});
test('case to manager activation clears stale case focus target',async()=>{
 const f=fixture();f.ctx.document.querySelector=s=>s==='#caseBackList'?{addEventListener(){}}:null;f.ctx.state.cases=[project()];f.ctx.renderCasePage('p');f.ctx.renderProjectManager(project());
 assert.equal(f.ctx.state.caseView,false);assert.equal(f.ctx.state.activeCaseId,'');let refreshed=0;f.ctx.refreshProjectAlbumMedia=async()=>refreshed++;f.handlers.focus();assert.equal(refreshed,1);assert.doesNotMatch(f.app.innerHTML,/case-media-card/);
});
