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
test('same-session reselection waits for delayed pause acknowledgement before resume or PUT',async()=>{
 let paused=false,releasePause,pauseStarted=false;const paths=[];
 const env=harness({esc:s=>String(s),projectMediaFileType:()=> 'image',fetch:async url=>{
 paths.push(url);
 if(url.endsWith('/init'))return response({sessionId:'s',status:'uploading',partSize:10,partCount:1});
 if(url.endsWith('/pause')){pauseStarted=true;await new Promise(resolve=>releasePause=resolve);paused=true;return response({status:'paused'});}
 if(url.endsWith('/status'))return response({sessionId:'s',status:paused?'paused':'uploading',filename:'a.jpg',fileSize:10,partSize:10,partCount:1});
 if(url.endsWith('/resume')){paused=false;return response({status:'uploading',sessionId:'s',fileSize:10,partSize:10,partCount:1});}
 if(url.includes('part-url'))return response({url:'https://tos/p'});
 return response({sessionId:'s',status:'queued'});
 }});
 const first=env.ctx.runProjectUploadBatch('p',[photo]);await flush();assert.equal(env.requests.length,1);
 env.ctx.stopProjectUploadFile('p');await first;await flush();assert.equal(pauseStarted,true);
 const before=paths.length;const second=env.ctx.runProjectUploadBatch('p',[photo]);await flush();assert.equal(env.requests.length,1);assert.equal(paths.length,before,'must wait before even reading pre-pause state');
 releasePause();await flush();assert.equal(env.requests.length,2);env.requests[1].done();await second;assert.equal(paused,false);assert.equal(env.ctx.state.projectUploadBatch.items[0].status,'processing');
});
test('completed transition retains pending media refresh across failure then next-poll success',async()=>{
 let albums=0;const env=harness({fetch:async url=>url.endsWith('/upload-sessions')?response({sessions:[{sessionId:'q',status:'completed'}]}):(++albums===1?response({error:'temporarily unavailable'},400):response({project:{id:'p',media:[{type:'image',url:'u'}]}})),projectMediaGroups:p=>({images:p.media,videos:[]})});
 env.ctx.state.projectView='manager';env.ctx.state.projectUploadSessions=[{sessionId:'q',status:'queued'}];
 await assert.rejects(env.ctx.refreshProjectUploadSessions('p'),/temporarily unavailable/);
 await env.tick(15000);assert.equal(albums,2);assert.equal(env.ctx.state.currentProject.media.length,1);assert.equal(env.ctx.state.projectUploadSessionsError,'');
 await env.tick(60000);assert.equal(albums,2,'successful refresh clears pending work');
});
test('direct published result retries failed album refresh through bounded polling',async()=>{
 let albums=0;const env=harness({projectMediaFileType:()=> 'image',projectMediaGroups:p=>({images:p.media,videos:[]}),fetch:async(url)=>{
 if(url.endsWith('/init'))return response({status:'completed',sessionId:'s',media:{url:'u'}});
 if(url.endsWith('/upload-sessions'))return response({sessions:[{sessionId:'s',status:'completed'}]});
 albums++;return albums===1?response({error:'album stale'},400):response({project:{id:'p',media:[{type:'image',url:'u'}]}});
 }});
 env.ctx.state.projectView='manager';await env.ctx.runProjectUploadBatch('p',[photo]);assert.equal(albums,1);
 await env.tick(15000);assert.equal(albums,2);assert.equal(env.ctx.state.currentProject.media.length,1);assert.equal(env.ctx.state.projectUploadBatch.items[0].message,undefined);
});
test('queued photo describes validation and saving while video retains conversion wording',()=>{
 const env=harness({esc:s=>String(s)});
 env.ctx.state.projectUploadSessions=[{sessionId:'photo',type:'image',title:'photo.jpg',status:'queued',progress:{label:'排队等待转换',percent:null}},{sessionId:'video',type:'video',title:'video.mp4',status:'queued'}];
 const html=env.ctx.projectUploadSessionsHtml('p');
 const photoRow=html.slice(html.indexOf('data-project-session="photo"'),html.indexOf('data-project-session="video"'));
 assert.match(photoRow,/等待照片校验.*入库/);assert.doesNotMatch(photoRow,/转换/);
 assert.match(html.slice(html.indexOf('data-project-session="video"')),/排队等待转换/);
 assert.doesNotMatch(html,/上传完成后自动逐条转换/);
});

for(const count of [4,40])test(`reopened ${count} manifest reconciles beyond three recent receipts`,async()=>{
 const env=harness({fetch:async url=>url.endsWith('/upload-sessions')?response({sessions:Array.from({length:3},(_,i)=>({sessionId:'s'+i,status:'completed'}))}):response({sessionId:url.split('/').at(-2),status:'completed',duplicate:false})});
 env.ctx.state.projectView='manager';env.ctx.refreshProjectAlbumMedia=async()=>{};
 env.ctx.state.projectUploadBatch={projectId:'p',items:Array.from({length:count},(_,i)=>({sessionId:'s'+i,status:'processing'}))};
 await env.ctx.refreshProjectUploadSessions('p');assert.equal(env.ctx.state.projectUploadBatch.items.filter(x=>x.status==='published').length,count);
});
test('exhausted complete and status response loss keeps session and later reconciles publication',async()=>{
 let recovered=false;const env=harness({projectMediaFileType:()=> 'image',fetch:async url=>{
 if(url.endsWith('/init'))return response({sessionId:'s',status:'uploading',partSize:10,partCount:1});
 if(url.includes('part-url'))return response({url:'https://tos/p'});
 if(url.endsWith('/upload-sessions'))return response({sessions:[]});
 if(url.endsWith('/status') && recovered)return response({sessionId:'s',status:'completed',duplicate:false});
 throw new TypeError('lost response');
 }});env.ctx.refreshProjectAlbumMedia=async()=>{};
 const pending=env.ctx.runProjectUploadBatch('p',[photo]);await flush();env.requests[0].done();await pending;
 assert.equal(env.ctx.state.projectUploadBatch.items[0].sessionId,'s');assert.equal(env.ctx.state.projectUploadBatch.items[0].status,'failed');
 recovered=true;env.ctx.state.projectView='manager';await env.ctx.refreshProjectUploadSessions('p');assert.equal(env.ctx.state.projectUploadBatch.items[0].status,'published');assert.equal(env.ctx.state.projectUploadBatch.items[0].message,undefined);
});
