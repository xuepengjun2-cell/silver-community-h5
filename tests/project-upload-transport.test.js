const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
function harness(overrides = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), storage = new Map(), requests = [];
  class XHR {
    constructor() { this.upload = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(body) { this.body = body; }
    abort() { this.onabort?.(); }
    done(status = 200, data = {}) { this.status = status; this.responseText = JSON.stringify(data); this.onload(); }
    progress(loaded) { this.upload.onprogress({ loaded, lengthComputable: true }); }
  }
  const ctx = vm.createContext({ console, AbortController, URLSearchParams, Uint8Array, crypto: webcrypto, XMLHttpRequest: XHR,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { timers.set(++serial, { fn, at: now + ms }); return serial; }, clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k) },
    state: { projectView: 'other', currentProject: {id:'p'}, projectUploadSessions: [], projectUploadTaskMessages: {}, projectUploadTaskActions: {} },
    document: {querySelector:()=>null,querySelectorAll:()=>[]}, apiUrl:x=>x, normalizeUrls:x=>x,
    ...overrides });
  vm.runInContext(source.slice(source.indexOf('const PROJECT_VIDEO_PART_RETRIES'), source.indexOf('\nfunction projectShareButton')), ctx);
  vm.runInContext(source.slice(source.indexOf('function projectUploadSessionsHtml'),source.indexOf('\nfunction renderProjectManager')),ctx);
  return {ctx,storage,requests, async tick(ms) { const end=now+ms; while(true) { const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!next)break; now=next[1].at;timers.delete(next[0]);next[1].fn();await flush(); } now=end;await flush(); }};
}
async function flush() { for(let i=0;i<100;i++)await Promise.resolve(); }
const photo = {name:'a.jpg',type:'image/jpeg',size:10,lastModified:7,slice:(a,b)=>({size:b-a})};
function response(data,status=200) { return {ok:status<400,status,json:async()=>data}; }
if (require.main !== module) module.exports={harness,flush,photo,response};

if(require.main===module) {
test('raster uses multipart, persists id before init, and retains completed receipt',async()=>{
 let env, initBody;
 env=harness({projectMediaFileType:()=> 'image',fetch:async(url,opts)=>{
   if(url.endsWith('/init')) {initBody=JSON.parse(opts.body);assert.equal([...env.storage.values()].some(v=>JSON.parse(v).clientUploadId===initBody.clientUploadId),true);return response({sessionId:'s',partSize:8388608,partCount:1,status:'uploading'});}
   if(url.includes('part-url'))return response({url:'https://tos/part'});
   if(url.includes('/complete'))return response({status:'completed',media:{url:'photo'},duplicate:false});
   throw Error('unexpected raw upload '+url);
 }});
 const pending=env.ctx.uploadProjectMediaFile('p',photo);await flush();
 assert.equal(env.requests.length,1); assert.equal(env.requests[0].method,'PUT');assert.equal(env.requests[0].withCredentials,false);
 env.requests[0].done();assert.equal((await pending).status,'completed');
 assert.match(initBody.clientUploadId,/^[a-f0-9]{32}$/);
 assert.equal([...env.storage.values()].some(v=>JSON.parse(v).status==='completed'),true);
});
test('continuous byte progress survives 180 seconds; true idle expires at 90 seconds',async()=>{
 const env=harness();const values=[];
 const pending=env.ctx.projectUploadXHR('https://tos/p',{method:'PUT',body:photo,onProgress:n=>values.push(n)});
 let error;pending.catch(e=>error=e);
 for(let i=1;i<=4;i++){await env.tick(60000);env.requests[0].progress(i*2);}
 assert.equal(error,undefined);assert.deepEqual(values,[2,4,6,8]);
 await env.tick(90000);await assert.rejects(pending,/进展|超时/);
});
test('control deadline includes hung JSON consumption and does not retry permission denial',async()=>{
 let calls=0;const env=harness({fetch:async()=>{calls++;return {ok:true,status:200,json:()=>new Promise(()=>{})};}});
 const pending=env.ctx.projectUploadControl('/status',{},1);pending.catch(()=>{});await flush();await env.tick(30000);
 await assert.rejects(pending,/超时/);assert.equal(calls,1);
 let denied=0;const e2=harness({fetch:async()=>{denied++;return response({error:'forbidden'},403);}});
 await assert.rejects(e2.ctx.projectUploadControl('/status'),/forbidden/);assert.equal(denied,1);
});
test('abort before init reply prevents any PUT and preserves request identity',async()=>{
 let env;env=harness({projectMediaFileType:()=> 'image',fetch:()=>new Promise(()=>{})});
 const c=new AbortController();const pending=env.ctx.uploadProjectMediaFile('p',photo,undefined,c);pending.catch(()=>{});await flush();c.abort();
 await assert.rejects(pending,e=>e.code==='UPLOAD_PAUSED');assert.equal(env.requests.length,0);assert.equal(env.storage.size,1);
});
test('queued reselection queries same receipt and never uploads again',async()=>{
 const paths=[];const env=harness({projectMediaFileType:()=> 'image',fetch:async url=>{paths.push(url);return response({sessionId:'s',status:'queued'});}});
 env.storage.set(env.ctx.projectUploadStateKey('p',photo),JSON.stringify({sessionId:'s',clientUploadId:'a'.repeat(32),status:'queued'}));
 assert.equal((await env.ctx.uploadProjectMediaFile('p',photo)).status,'queued');assert.equal(paths.length,1);assert.match(paths[0],/\/status$/);assert.equal(env.requests.length,0);
});

test('lost init response reuses request ID; lost complete checks status before another merge',async()=>{
 const ids=[],paths=[];let initCalls=0,completeCalls=0;
 const env=harness({projectMediaFileType:()=> 'image',fetch:async(url,opts)=>{
 paths.push(url);
 if(url.endsWith('/init')){ids.push(JSON.parse(opts.body).clientUploadId);if(++initCalls===1)throw new TypeError('lost init');return response({sessionId:'s',status:'uploading',partSize:10,partCount:1});}
 if(url.includes('part-url'))return response({url:'https://tos/part'});
 if(url.includes('/complete')){completeCalls++;throw new TypeError('lost complete');}
 if(url.endsWith('/status'))return response({sessionId:'s',status:'queued'});
 throw Error(url);
 }});
 const pending=env.ctx.uploadProjectMediaFile('p',photo);await flush();env.requests[0].done();
 assert.equal((await pending).status,'queued');assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(completeCalls,1);
 assert.match(paths.at(-1),/status$/);
});
test('server-confirmed partial receipt skips first stored-boundary part, not local guesses',async()=>{
 const paths=[];const env=harness({projectMediaFileType:()=> 'video',fetch:async url=>{
 paths.push(url);if(url.endsWith('/status'))return response({sessionId:'s',status:'uploading',filename:'v.mp4',fileSize:25,partSize:10,partCount:3,completedParts:[1]});
 if(url.includes('part-url'))return response({url:'https://tos/'+url.split('partNumber=')[1]});
 return response({sessionId:'s',status:'queued'});
 }});
 const file={...photo,name:'v.mp4',type:'video/mp4',size:25};env.storage.set(env.ctx.projectUploadStateKey('p',file),JSON.stringify({sessionId:'s',completedParts:[1,2]}));
 const bytes=[];const pending=env.ctx.uploadProjectMediaFile('p',file,p=>bytes.push(p.uploadedBytes));await flush();
 assert.equal(env.requests.length,2);assert.equal(env.requests[0].body.size,10);assert.equal(env.requests[1].body.size,5);assert.equal(paths.some(p=>p.endsWith('partNumber=1')),false);
 env.requests.forEach(r=>r.done());await pending;assert.equal(bytes.at(-1),25);
});
test('same part stops after four failed PUTs and resets unconfirmed retry progress',async()=>{
 const bytes=[];const env=harness({projectMediaFileType:()=> 'image',fetch:async url=>url.endsWith('/init')?response({sessionId:'s',partSize:10,partCount:1,status:'uploading'}):response({url:'https://tos/part'})});
 const pending=env.ctx.uploadProjectMediaFile('p',photo,p=>bytes.push(p.uploadedBytes));pending.catch(()=>{});
 for(let i=0;i<4;i++){await flush();env.requests[i].progress(5);env.requests[i].done(503);}
 await assert.rejects(pending,/503/);assert.equal(env.requests.length,4);assert.ok(bytes.some((n,i)=>i>0 && n===0 && bytes[i-1]===5));
});
test('absolute part deadline expires even with continuous bytes',async()=>{
 const env=harness();const pending=env.ctx.projectUploadXHR('https://tos',{body:{size:1000}});pending.catch(()=>{});
 for(let n=1;n<30;n++){await env.tick(60000);env.requests[0].progress(n);}
 await env.tick(60000);await assert.rejects(pending,/超时/);
});
test('SVG stays one observable legacy POST and queued photo is never counted as published',async()=>{
 const env=harness({projectMediaFileType:()=> 'image'});const values=[];
 const pending=env.ctx.uploadProjectMediaFile('p',{...photo,name:'v.svg',type:'image/svg+xml'},p=>values.push(p.percent));
 assert.match(env.requests[0].url,/media\?type=image/);assert.equal(env.requests[0].method,'POST');env.requests[0].progress(4);env.requests[0].done(200,{url:'legacy.svg'});
 assert.equal(env.ctx.projectUploadOutcome(await pending,'image'),'published');assert.equal(env.ctx.projectUploadOutcome({status:'queued'},'image'),'processing');assert.deepEqual(values,[40]);
});
test('completed deleted reference and mismatched metadata are refused without new transfer',async()=>{
 for(const status of ['completed','uploading']) {
 const env=harness({projectMediaFileType:()=> 'image',fetch:async url=>url.endsWith('/status')?response({status,filename:'changed.jpg',fileSize:999,sessionId:'s'}):response({error:'reference deleted'},409)});
 env.storage.set(env.ctx.projectUploadStateKey('p',photo),JSON.stringify({sessionId:'s'}));
 await assert.rejects(env.ctx.uploadProjectMediaFile('p',photo),/不一致|deleted/);assert.equal(env.requests.length,0);assert.equal(env.storage.size,1);
 }
});
test('retryable HTTP with malformed JSON still retries, permission denial never does',async()=>{
 let calls=0;const env=harness({fetch:async()=>++calls===1?{ok:false,status:503,json:async()=>{throw new SyntaxError('bad json');}}:response({status:'ok'})});
 assert.equal((await env.ctx.projectUploadControl('/status')).status,'ok');assert.equal(calls,2);
});

test('unavailable durable storage refuses init rather than risking duplicate sessions',async()=>{
 let calls=0;const env=harness({projectMediaFileType:()=> 'image',localStorage:{getItem:()=>null,setItem:()=>{throw Error('quota');}},fetch:async()=>{calls++;return response({sessionId:'s',status:'completed'});}});
 await assert.rejects(env.ctx.uploadProjectMediaFile('p',photo),/本地|保存/);assert.equal(calls,0);
});
test('photo hashes bytes with SHA256; video never reads whole file for hashing',async()=>{
 let reads=0;const bodies=[];
 class Reader {readAsArrayBuffer(){reads++;this.result=new Uint8Array([1,2,3]).buffer;this.onload();}abort(){this.onabort?.();}}
 const env=harness({FileReader:Reader,projectMediaFileType:f=>f.type.startsWith('image')?'image':'video',fetch:async(url,opts)=>{bodies.push(JSON.parse(opts.body));return response({sessionId:'s',status:'completed',duplicate:true,media:{url:'u'}});}});
 await env.ctx.uploadProjectMediaFile('p',photo);await env.ctx.uploadProjectMediaFile('p',{...photo,name:'v.mp4',type:'video/mp4'});
 assert.equal(reads,1);assert.equal(bodies[0].fingerprint,'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');assert.equal(bodies[1].fingerprint,undefined);
});

test('explicit removed-result receipt permits exactly one new identity and full reupload',async()=>{
 const bodies=[],paths=[];const oldId='a'.repeat(32);
 const env=harness({projectMediaFileType:()=> 'image',fetch:async(url,opts)=>{
 paths.push(url);
 if(url.endsWith('/status'))return response({error:'deleted',code:'UPLOAD_RESULT_REMOVED'},409);
 if(url.endsWith('/init')){bodies.push(JSON.parse(opts.body));return response({sessionId:'fresh',status:'uploading',partSize:10,partCount:1});}
 if(url.includes('part-url'))return response({url:'https://tos/fresh'});
 if(url.includes('/complete'))return response({sessionId:'fresh',status:'completed',media:{url:'validated-new'}});
 throw Error(url);
 }});
 const key=env.ctx.projectUploadStateKey('p',photo);env.storage.set(key,JSON.stringify({clientUploadId:oldId,sessionId:'deleted',status:'completed',media:{url:'never-resurrect'}}));
 const pending=env.ctx.uploadProjectMediaFile('p',photo);await flush();assert.equal(env.requests.length,1);env.requests[0].done();
 assert.equal((await pending).media.url,'validated-new');assert.equal(bodies.length,1);assert.notEqual(bodies[0].clientUploadId,oldId);assert.match(bodies[0].clientUploadId,/^[a-f0-9]{32}$/);assert.equal(env.requests[0].body.size,10);assert.equal(JSON.parse(env.storage.get(key)).sessionId,'fresh');assert.equal(paths.some(url=>url.includes('never-resurrect')),false);
});
test('generic missing/conflict retains receipt; repeated explicit removal stops after one reset',async()=>{
 for(const status of [404,409]) {
 let inits=0;const env=harness({projectMediaFileType:()=> 'image',fetch:async url=>{if(url.endsWith('/init'))inits++;return response({error:'generic'},status);}});
 const key=env.ctx.projectUploadStateKey('p',photo);env.storage.set(key,JSON.stringify({clientUploadId:'a'.repeat(32),sessionId:'old',status:'completed'}));
 await assert.rejects(env.ctx.uploadProjectMediaFile('p',photo),/generic/);assert.equal(inits,0);assert.equal(JSON.parse(env.storage.get(key)).sessionId,'old');
 }
 let inits=0;const env=harness({projectMediaFileType:()=> 'image',fetch:async url=>{if(url.endsWith('/init'))inits++;return response({error:'deleted again',code:'UPLOAD_RESULT_REMOVED'},409);}});
 const key=env.ctx.projectUploadStateKey('p',photo);env.storage.set(key,JSON.stringify({clientUploadId:'a'.repeat(32),sessionId:'old',status:'completed'}));
 await assert.rejects(env.ctx.uploadProjectMediaFile('p',photo),/deleted again/);assert.equal(inits,1);assert.notEqual(JSON.parse(env.storage.get(key)).clientUploadId,'a'.repeat(32));
});

test('paused photo and video reselection requery authoritative metadata after minimal resume response',async()=>{
 for(const type of ['image','video']) {
 let resumed=false,statusCalls=0;
 const file={...photo,name:type==='image'?'a.jpg':'v.mp4',type:type==='image'?'image/jpeg':'video/mp4'};
 const env=harness({projectMediaFileType:()=>type,fetch:async url=>{
 if(url.endsWith('/status')){statusCalls++;return response({sessionId:'s',status:resumed?'uploading':'paused',filename:file.name,fileSize:10,partSize:10,partCount:1,completedParts:[]});}
 if(url.endsWith('/resume')){resumed=true;return response({ok:true,status:'uploading',sessionId:'s',fileSize:10,partSize:10,partCount:1});}
 if(url.includes('part-url'))return response({url:'https://tos/p'});
 return response({sessionId:'s',status:'queued'});
 }});
 env.storage.set(env.ctx.projectUploadStateKey('p',file),JSON.stringify({sessionId:'s'}));
 const pending=env.ctx.uploadProjectMediaFile('p',file);pending.catch(()=>{});await flush();assert.equal(env.requests.length,1);env.requests[0].done();assert.equal((await pending).status,'queued');assert.equal(statusCalls,2);
 }
});

}
