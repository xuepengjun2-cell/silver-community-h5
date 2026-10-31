const test=require('node:test');const assert=require('node:assert/strict');
const {harness,flush,photo,response}=require('./project-upload-transport.test');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8');
function renderFunctions(ctx){vm.runInContext(source.slice(source.indexOf('function projectUploadSessionsHtml'),source.indexOf('\nfunction renderProjectManager')),ctx);}
test('mixed40 stalled first init finishes visibly and remaining files proceed',async()=>{
 let inits=0;const env=harness({projectMediaFileType:f=>f.type.startsWith('video')?'video':'image',fetch:async(url,opts)=>{
 if(url.endsWith('/init')){inits++;const body=JSON.parse(opts.body);if(body.title==='stalled.jpg')return new Promise(()=>{});return response({sessionId:'s'+inits,status:'completed',duplicate:true,media:{url:'u',poster:'p',size:100}});}throw Error(url);
 }});
 const files=[{...photo,name:'stalled.jpg'},...Array.from({length:39},(_,i)=>({...photo,name:`f${i}.${i%2?'mp4':'jpg'}`,type:i%2?'video/mp4':'image/jpeg'}))];
 const promise=env.ctx.runProjectUploadBatch('p',files);await flush();
 assert.equal(env.ctx.state.projectUploadBatch.items.length,40);
 await env.tick(90000);await promise;
 const items=env.ctx.state.projectUploadBatch.items;
 assert.equal(items[0].status,'failed');assert.equal(items.filter(i=>i.status==='duplicate').length,39);assert.equal(env.ctx.state.projectUploading,false);
 assert.equal([...env.storage.values()].some(v=>{const x=JSON.parse(v);return x.items?.length===40;}),true);
});
test('current file can be skipped while init has no session and next file completes',async()=>{
 const env=harness({projectMediaFileType:()=> 'image',fetch:async(url,opts)=>JSON.parse(opts.body).title==='a.jpg'?new Promise(()=>{}):response({status:'completed',duplicate:true,sessionId:'ok',media:{url:'u'}})});
 const pending=env.ctx.runProjectUploadBatch('p',[photo,{...photo,name:'b.jpg'}]);await flush();
 env.ctx.stopProjectUploadFile('p','skip');await pending;
 assert.equal(env.ctx.state.projectUploadBatch.items[0].status,'skipped');assert.equal(env.ctx.state.projectUploadBatch.items[1].status,'duplicate');
});
test('more than50 tasks expand; oldest processing and current upload remain visible',()=>{
 const env=harness({esc:s=>String(s)});renderFunctions(env.ctx);
 env.ctx.state.projectUploadSessions=Array.from({length:70},(_,i)=>({sessionId:'s'+i,title:'name'+i,status:'queued'}));
 env.ctx.state.projectUploadSessions[69].status='processing';env.ctx.state.projectUploadTransfer={projectId:'p',sessionId:'s68'};
 const html=env.ctx.projectUploadSessionsHtml('p');assert.match(html,/name69/);assert.match(html,/name68/);assert.match(html,/70/);assert.match(html,/<details[^>]*project-task-overflow/);assert.match(html,/name60/);
});
test('hung poll consumes finite retries then recovery reschedules in finally',async()=>{
 let calls=0;const env=harness({esc:s=>String(s),fetch:async()=>{calls++;if(calls<=3)return new Promise(()=>{});return response({sessions:[{sessionId:'q',status:'queued'}],total:1});}});renderFunctions(env.ctx);
 env.ctx.state.projectView='manager';env.ctx.state.projectUploadSessions=[{sessionId:'q',status:'queued'}];
 env.ctx.scheduleProjectUploadPoll('p');await env.tick(94000);assert.match(env.ctx.state.projectUploadSessionsError,/超时/);
 await env.tick(15000);assert.equal(env.ctx.state.projectUploadSessionsError,'');assert.equal(calls,4);
});
test('media-only refresh leaves unsaved metadata form untouched',async()=>{
 const form={value:'unsaved title'},grid={innerHTML:'',querySelectorAll:()=>[]},count={textContent:''};
 const env=harness({projectMediaGroups:p=>({images:p.media.filter(m=>m.type==='image'),videos:[]}),projectMediaCardHtml:()=>'<article>photo</article>',bindProjectVideoThumbs:()=>{},bindProjectDownloadEvents:()=>{},bindProjectShareEvents:()=>{},fetch:async()=>response({project:{id:'p',canManage:true,media:[{type:'image',url:'u'}]}}),document:{querySelector:s=>s==='#projectMetaForm'?form:s==='.project-media-grid'?grid:s.includes('images')?count:null,querySelectorAll:()=>[]}});
 env.ctx.state.projectView='manager';await env.ctx.refreshProjectAlbumMedia('p');
 assert.equal(form.value,'unsaved title');assert.match(grid.innerHTML,/photo/);assert.equal(count.textContent,'1');
});
test('background result updates batch failure/publication counts without a form reload',async()=>{
 const env=harness({esc:s=>String(s),fetch:async()=>response({sessions:[{sessionId:'a',status:'delivery_failed'},{sessionId:'b',status:'completed',duplicate:true}]})});
 env.ctx.state.projectView='manager';env.ctx.state.projectUploadSessions=[{sessionId:'a',status:'queued'},{sessionId:'b',status:'queued'}];
 env.ctx.state.projectUploadBatch={projectId:'p',items:[{name:'bad',status:'processing',sessionId:'a'},{name:'good',status:'processing',sessionId:'b'}]};
 env.ctx.refreshProjectAlbumMedia=async()=>{};
 await env.ctx.refreshProjectUploadSessions('p');
 assert.equal(env.ctx.state.projectUploadBatch.items[0].status,'failed');assert.equal(env.ctx.state.projectUploadBatch.items[1].status,'duplicate');
 const html=env.ctx.projectUploadProgressHtml('p');assert.match(html,/1 项重复合并/);assert.match(html,/1 项失败/);assert.doesNotMatch(html,/2 项交给后台处理/);
});
test('mixed40 first photo stalls during PUT; four idle attempts release all remaining inputs',async()=>{
 const env=harness({esc:s=>String(s),projectMediaFileType:f=>f.type.startsWith('video')?'video':'image',fetch:async(url,opts)=>{
 if(url.endsWith('/init')) {const body=JSON.parse(opts.body);return response(body.title==='stalled.jpg'?{sessionId:'s',status:'uploading',partSize:8388608,partCount:1}:{sessionId:body.title,status:'completed',duplicate:true,media:{url:'u',poster:'p',size:10}});}
 if(url.includes('part-url'))return response({url:'https://tos/part'});
 throw Error('unexpected '+url);
 }});
 const files=[{...photo,name:'stalled.jpg'},...Array.from({length:39},(_,i)=>({...photo,name:`file${i}.${i%2?'mp4':'jpg'}`,type:i%2?'video/mp4':'image/jpeg'}))];
 const pending=env.ctx.runProjectUploadBatch('p',files);await flush();assert.equal(env.requests.length,1);
 await env.tick(360000);await pending;
 assert.equal(env.requests.length,4);assert.equal(env.ctx.state.projectUploadBatch.items[0].status,'failed');assert.equal(env.ctx.state.projectUploadBatch.items.filter(i=>i.status==='duplicate').length,39);
 assert.equal((env.ctx.projectUploadProgressHtml('p').match(/data-batch-index=/g)||[]).length,40);
});
