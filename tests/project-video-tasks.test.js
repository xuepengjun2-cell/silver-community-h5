const test=require('node:test');
const assert=require('node:assert/strict');
const {createProjectVideoTasks}=require('../server/project-video-tasks');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

function setup(config={}){
 const makeRow=(id,status='uploading')=>({id,project_id:'album',owner_id:'uploader',object_key:'source/'+id,upload_id:'multipart-'+id,file_size:100,part_size:64,part_count:2,status,error:null});
 const rows=new Map((config.rows||[makeRow('task',config.status)]).map(r=>[r.id,{...r}]));
 const state={allowed:true,merged:new Set(config.merged?['task']:[]),enqueued:new Set(),updates:[],auth:[],controlAuth:[],storageCalls:[],deletedObjects:0,merges:0,errors:[]};
 const validParts=[{PartNumber:1,Size:64,ETag:'part1'},{PartNumber:2,Size:36,ETag:'part2'}];
 const options={
   read:async id=>rows.has(id)?{...rows.get(id)}:null,
   update:async(id,fields)=>{state.updates.push({id,...fields});rows.set(id,{...rows.get(id),...fields});},
   canManage:async(row,actor)=>{state.auth.push({row:{...row},actor});return config.canManage?config.canManage(row,actor,state):state.allowed;},
   enabled:()=>config.enabled!==false,
   preparing:new Set(),
   getStorage:()=>({bucket:'test-bucket',client:{
     headObject:async({key})=>{state.storageCalls.push('head');if(config.headError)throw config.headError;if(!state.merged.has(key.slice(7)))throw Object.assign(Error('missing'),{statusCode:404});return{bytes:100};},
     listParts:async({key})=>{state.storageCalls.push('listParts');await config.onListParts?.(rows,state,key);return{data:{Parts:config.partsFor?config.partsFor(key):config.parts||validParts}};},
     completeMultipartUpload:async({key})=>{state.storageCalls.push('merge');state.merges++;state.merged.add(key.slice(7));await config.onMerge?.(rows,state,key);},
     deleteObject:async()=>{state.deletedObjects++;}
   }}),
   assertSize:(head,expected)=>{if(head.bytes!==Number(expected))throw Error('size mismatch');},
   listQueued:async()=>[...rows.values()].filter(r=>['queued','processing'].includes(r.status)).map(r=>({...r})),
   listUploading:async()=>[...rows.values()].filter(r=>r.status==='uploading').map(r=>({...r})),
   pendingCount:()=>Number(config.basePending||0)+state.enqueued.size,
   enqueue:id=>state.enqueued.add(id),
   removeQueued:id=>state.enqueued.delete(id),
   log:error=>state.errors.push(error)
 };
 if(config.canControl)options.canControl=async(row,actor)=>{state.controlAuth.push({row:{...row},actor});return config.canControl(row,actor,state);};
 return{tasks:createProjectVideoTasks(options),rows,state,options,makeRow};
}

test('at capacity, full uploaded source becomes durable queued without starting seventh task',async()=>{
 const h=setup({basePending:6});const row=await h.tasks.prepare('task',{actor:'owner'});await flush();
 assert.equal(row.status,'queued');assert.equal(h.rows.get('task').status,'queued');assert.equal(h.state.enqueued.size,0);
 assert.equal(h.state.merges,1);assert.equal(h.state.deletedObjects,0);
});

test('complete multipart validates sizes and ETags then rechecks same actor before queueing',async()=>{
 const h=setup();const resolver=()=>({id:'owner'});await h.tasks.prepare('task',{actor:resolver});await flush();
 assert.equal(h.state.auth.length,2);assert.ok(h.state.auth.every(a=>a.actor===resolver));assert.equal(h.state.enqueued.size,1);
});

test('partial uploads remain uploading and auto recovery does not finalize them',async()=>{
 const h=setup({parts:[{PartNumber:1,Size:64,ETag:'part1'}]});const r=await h.tasks.prepare('task',{auto:true});
 assert.equal(r.valid,false);assert.equal(h.rows.get('task').status,'uploading');assert.equal(h.state.merges,0);assert.equal(h.state.enqueued.size,0);
});

test('unexpected part size, duplicate number, or absent ETag never merges',async()=>{
 for(const parts of [
  [{PartNumber:1,Size:63,ETag:'a'},{PartNumber:2,Size:37,ETag:'b'}],
  [{PartNumber:1,Size:64,ETag:'a'},{PartNumber:1,Size:36,ETag:'b'}],
  [{PartNumber:1,Size:64,ETag:''},{PartNumber:2,Size:36,ETag:'b'}],
  [{PartNumber:1,Size:64,ETag:{}},{PartNumber:2,Size:36,ETag:'b'}]
 ]){
  const h=setup({parts});await assert.rejects(h.tasks.prepare('task'),e=>e.code==='VIDEO_UPLOAD_INCOMPLETE');assert.equal(h.state.merges,0);
 }
});

test('invalid persisted part metadata cannot validate an empty list',async()=>{
 for(const fields of [{part_count:0},{part_count:1.5},{file_size:0},{part_size:0},{part_count:10001},{part_count:3}]){
  const h=setup({parts:[]});Object.assign(h.rows.get('task'),fields);
  await assert.rejects(h.tasks.parts(h.rows.get('task')),e=>e.code==='VIDEO_UPLOAD_METADATA');assert.deepEqual(h.state.storageCalls,[]);
 }
});

test('forbidden actor is rejected before reading or merging any source object',async()=>{
 const h=setup({canManage:(_row,actor)=>actor==='owner'});
 await assert.rejects(h.tasks.prepare('task',{actor:'other'}),e=>e.httpStatus===403);assert.deepEqual(h.state.storageCalls,[]);
});

test('permission revoked during merge prevents automatic queueing',async()=>{
 const h=setup({onMerge:async(_rows,state)=>{state.allowed=false;}});
 await assert.rejects(h.tasks.prepare('task',{actor:'owner'}),e=>e.httpStatus===403);
 assert.equal(h.state.merges,1);assert.equal(h.rows.get('task').status,'uploading');assert.equal(h.state.enqueued.size,0);assert.equal(h.state.deletedObjects,0);
});

test('status changed externally while TOS merges is never resurrected queued',async()=>{
 for(const status of ['paused','aborted','dismissed']){
  const h=setup({onMerge:async rows=>{rows.get('task').status=status;}});
  await assert.rejects(h.tasks.prepare('task',{auto:true}),e=>e.httpStatus===409);
  assert.equal(h.rows.get('task').status,status);assert.equal(h.state.enqueued.size,0);assert.equal(h.state.deletedObjects,0);
 }
});

test('source identity changed while merging is not queued against stale object',async()=>{
 const h=setup({onMerge:async rows=>{rows.get('task').object_key='source/replaced';}});
 await assert.rejects(h.tasks.prepare('task'),e=>e.httpStatus===409);assert.equal(h.rows.get('task').status,'uploading');
});

test('a forbidden HEAD response never falls back to completing multipart',async()=>{
 const h=setup({headError:Object.assign(Error('forbidden'),{statusCode:403})});
 await assert.rejects(h.tasks.prepare('task'),/forbidden/);assert.deepEqual(h.state.storageCalls,['head']);
});

test('paused upload requires explicit resume, partial resume safely waits for remaining parts',async()=>{
 const h=setup({status:'paused',parts:[{PartNumber:1,Size:64,ETag:'part1'}]});
 await assert.rejects(h.tasks.prepare('task',{auto:true}),e=>e.httpStatus===409);
 const row=await h.tasks.prepare('task',{resume:true});assert.equal(row.status,'uploading');assert.equal(h.rows.get('task').status,'uploading');assert.equal(h.state.merges,0);
});

test('failed partial upload resumes uploading without merging or losing uploaded parts',async()=>{
 const h=setup({status:'failed',parts:[{PartNumber:1,Size:64,ETag:'part1'}]});h.rows.get('task').error='old upload interruption';
 const row=await h.tasks.prepare('task',{resume:true,actor:'owner'});
 assert.equal(row.status,'uploading');assert.equal(h.rows.get('task').status,'uploading');assert.equal(row.error,null);
 assert.deepEqual(row.completedParts,[1]);assert.equal(row.uploadedBytes,64);assert.equal(h.state.merges,0);assert.equal(h.state.deletedObjects,0);
});

test('permission revoked while listing partial upload prevents resume state change',async()=>{
 const resolver=()=>({id:'owner'}),h=setup({status:'paused',parts:[{PartNumber:1,Size:64,ETag:'part1'}],onListParts:async(_rows,state)=>{state.allowed=false;}});
 await assert.rejects(h.tasks.prepare('task',{resume:true,actor:resolver}),e=>e.httpStatus===403);
 assert.equal(h.rows.get('task').status,'paused');assert.equal(h.state.updates.length,0);assert.equal(h.state.auth.length,2);
 assert.ok(h.state.auth.every(a=>a.actor===resolver));assert.equal(h.state.merges,0);assert.equal(h.state.enqueued.size,0);
});

test('partial-upload resume cannot overwrite status or source metadata changed during listParts',async()=>{
 for(const changed of [{status:'dismissed'},{status:'aborted'},{status:'delivery_failed'},{object_key:'source/replaced'},{upload_id:'multipart-replaced'},{owner_id:'replacement'},{project_id:'other-album'},{file_size:101},{part_size:63},{part_count:3}]){
  const h=setup({status:'paused',parts:[{PartNumber:1,Size:64,ETag:'part1'}],onListParts:async rows=>{Object.assign(rows.get('task'),changed);}});
  await assert.rejects(h.tasks.prepare('task',{resume:true}),e=>e.httpStatus===409);
  assert.deepEqual({...h.rows.get('task')},{...h.makeRow('task','paused'),...changed});assert.equal(h.state.updates.length,0);assert.equal(h.state.enqueued.size,0);
 }
});

test('dismiss is a soft task-only change and cannot be resumed automatically',async()=>{
 const h=setup({status:'delivery_failed'});await h.tasks.dismiss('task','owner');
 assert.equal(h.rows.get('task').status,'dismissed');assert.equal(h.state.deletedObjects,0);assert.equal(h.state.merges,0);
 await assert.rejects(h.tasks.prepare('task',{resume:true}),e=>e.httpStatus===409);
});

test('pause aborts only its own controller and retains source',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task');assert.ok(exec);
 await h.tasks.pause('task','owner');assert.equal(exec.signal.aborted,true);assert.equal(h.rows.get('task').status,'paused');assert.equal(h.state.deletedObjects,0);
 await assert.rejects(h.tasks.assertActive('task',exec.signal),e=>e.code==='VIDEO_TASK_ABORTED');
});

test('control authorization can stop or dismiss an orphan task without permitting publication or resume',async()=>{
 for(const action of ['pause','dismiss']){
  const resolver=()=>({id:'hq'}),h=setup({status:'queued',canControl:(_row,actor)=>actor===resolver}),exec=await h.tasks.begin('task');
  h.state.allowed=false;let published=false;
  await assert.rejects(h.tasks.publish('task',exec.signal,()=>{published=true;}),e=>e.httpStatus===403);assert.equal(published,false);
  const row=await h.tasks[action]('task',resolver);
  assert.equal(row.status,action==='pause'?'paused':'dismissed');assert.equal(exec.signal.aborted,true);assert.equal(h.state.deletedObjects,0);
  assert.equal(h.state.controlAuth.length,1);assert.equal(h.state.controlAuth[0].actor,resolver);
  await assert.rejects(h.tasks.prepare('task',{resume:true,actor:resolver}),e=>e.httpStatus===403);
  h.rows.get('task').status='queued';await assert.rejects(h.tasks.begin('task'),e=>e.httpStatus===403);
 }
});

test('control authorization overrides manage permission for pause and dismiss',async()=>{
 const h=setup({status:'queued',canControl:(_row,actor)=>actor==='hq'}),exec=await h.tasks.begin('task');
 for(const action of ['pause','dismiss'])await assert.rejects(h.tasks[action]('task','other'),e=>e.httpStatus===403);
 assert.equal(h.rows.get('task').status,'processing');assert.equal(exec.signal.aborted,false);assert.equal(h.state.deletedObjects,0);
});

test('failed processing-state persistence releases the execution slot for a later retry',async()=>{
 const h=setup({status:'queued'}),originalUpdate=h.options.update;let unavailable=true;
 h.options.update=async(id,fields)=>{if(fields.status==='processing'&&unavailable){unavailable=false;throw Error('SQL unavailable');}return originalUpdate(id,fields);};
 await assert.rejects(h.tasks.begin('task'),/SQL unavailable/);assert.equal(h.rows.get('task').status,'queued');
 const exec=await h.tasks.begin('task');assert.ok(exec);assert.equal(exec.signal.aborted,false);assert.equal(h.rows.get('task').status,'processing');
 await h.tasks.pause('task','owner');assert.equal(exec.signal.aborted,true);
});

test('no duplicate begin and no-control finish cannot erase active task controller',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task');assert.equal(await h.tasks.begin('task'),null);
 h.tasks.finish('task');await flush();await h.tasks.pause('task','owner');assert.equal(exec.signal.aborted,true);
});

test('publish serializes commit against pause; pause cannot undo completed result',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task'),entered=deferred(),release=deferred();
 const publication=h.tasks.publish('task',exec.signal,async()=>{entered.resolve();await release.promise;h.rows.get('task').status='completed';return'committed';});
 await entered.promise;let paused=false;const pause=h.tasks.pause('task','owner').then(r=>{paused=true;return r;});await flush();assert.equal(paused,false);
 release.resolve();assert.equal(await publication,'committed');assert.equal((await pause).status,'completed');assert.equal(exec.signal.aborted,false);
});

test('pause winning the lock prevents any publication callback',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task');await h.tasks.pause('task','owner');let published=false;
 await assert.rejects(h.tasks.publish('task',exec.signal,()=>{published=true;}),e=>e.code==='VIDEO_TASK_ABORTED');assert.equal(published,false);
});

test('permission revocation before publication prevents callback',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task');h.state.allowed=false;let published=false;
 await assert.rejects(h.tasks.publish('task',exec.signal,()=>{published=true;}),e=>e.httpStatus===403);assert.equal(published,false);
});

test('fail preserves paused/dismissed/aborted/completed and old abort cannot break resumed queue',async()=>{
 for(const status of ['paused','dismissed','aborted','completed']){
  const h=setup({status});await h.tasks.fail('task',Error('failure'));assert.equal(h.rows.get('task').status,status);assert.equal(h.state.updates.length,0);
 }
 const h=setup({status:'queued'});await h.tasks.fail('task',Object.assign(Error('old cancellation'),{name:'AbortError',code:'VIDEO_TASK_ABORTED'}));assert.equal(h.rows.get('task').status,'queued');
});

test('stale execution failure and finish cannot clobber a newly resumed execution',async()=>{
 const h=setup({status:'queued'}),old=await h.tasks.begin('task');await h.tasks.pause('task','owner');
 await h.tasks.prepare('task',{resume:true});const current=await h.tasks.begin('task');assert.ok(current);assert.notEqual(old.control,current.control);
 await h.tasks.fail('task',Error('late old failure'),old.control);assert.equal(h.rows.get('task').status,'processing');h.tasks.finish('task',old.control);
 await h.tasks.pause('task','owner');assert.equal(current.signal.aborted,true);
});

test('real active failure remains retriable with diagnostic text',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task');await h.tasks.fail('task',Error('codec warning'),exec.control);
 assert.equal(h.rows.get('task').status,'delivery_failed');assert.equal(h.rows.get('task').error,'codec warning');assert.equal(h.state.deletedObjects,0);
});

test('displayed progress never fabricates100 until authoritative completed state',async()=>{
 const h=setup({status:'queued'}),exec=await h.tasks.begin('task');exec.onProgress({phase:'converting',percent:140});
 assert.equal(h.tasks.getProgress(h.rows.get('task')).percent,99);h.rows.get('task').status='completed';assert.equal(h.tasks.getProgress(h.rows.get('task')).percent,100);
});

test('auto recovery rotates bounded scan batches so partial old files do not starve complete uploads',async()=>{
 const sample=setup(),rows=Array.from({length:7},(_,i)=>sample.makeRow('t'+i));
 const h=setup({rows,partsFor:key=>key==='source/t6'?[{PartNumber:1,Size:64,ETag:'a'},{PartNumber:2,Size:36,ETag:'b'}]:[]});
 await h.tasks.autoRecover();assert.equal(h.rows.get('t6').status,'uploading');await h.tasks.autoRecover();assert.equal(h.rows.get('t6').status,'queued');assert.equal(h.state.merges,1);
});

test('dispatch admits at most six workers and respects existing unrelated pending jobs',async()=>{
 const sample=setup(),rows=Array.from({length:9},(_,i)=>sample.makeRow('t'+i,'queued'));const h=setup({rows,basePending:4});
 await h.tasks.dispatch();assert.equal(h.state.enqueued.size,2);
});
