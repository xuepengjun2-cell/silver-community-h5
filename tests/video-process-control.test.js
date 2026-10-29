const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const vm=require('vm');
const {EventEmitter}=require('events');
const {PassThrough}=require('stream');
const SOURCE=require('path').join(__dirname,'../server/miniapp-media.js');

function harness(spawnImpl,fsOverride=fs){
 const signals=[];
 const context={require(name){
   if(name==='child_process')return{spawn:spawnImpl};
   if(name==='fs')return fsOverride;
   if(name==='busboy')return function(){};
   return require(name);
 },module:{exports:{}},exports:{},process:{platform:'linux',kill(pid,signal){signals.push({pid,signal});}},Buffer,setTimeout,clearTimeout,AbortController};
 vm.runInNewContext(fs.readFileSync(SOURCE,'utf8')+'\nmodule.exports.__run=run;',context,{filename:SOURCE});
 return{...context.module.exports,signals};
}

function child(pid=43210){
 const c=new EventEmitter();c.pid=pid;c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>true;return c;
}

test('already-aborted task never starts a child',async()=>{
 let starts=0;const media=harness(()=>{starts++;return child();});const control=new AbortController();control.abort();
 await assert.rejects(media.__run('ffmpeg',[],1000,{signal:control.signal}),e=>e.name==='AbortError'&&e.code==='VIDEO_TASK_ABORTED');
 assert.equal(starts,0);
});

test('FFmpeg elapsed timestamps produce monotonic real progress below100',async()=>{
 const c=child();let call;const events=[];const media=harness((...args)=>{call=args;return c;});
 const result=media.__run('ffmpeg',['-i','source','out.mp4'],1000,{progressDuration:10,phase:'converting',onProgress:p=>events.push(p)});
 c.stdout.write('out_time_us=200');c.stdout.write('0000\nout_time_ms=2000000\nout_time_us=9000000\nout_time_us=10000000\nprogress=end\n');
 c.emit('close',0,null);await result;
 assert.equal(call[0],'nice');assert.deepEqual(Array.from(call[1]).slice(0,6),['-n','19','ionice','-c','3','ffmpeg']);
 assert.equal(call[2].detached,true);assert.deepEqual(events.map(e=>e.percent),[20,90,99]);
 assert.ok(call[1].includes('-progress'));assert.ok(call[1].includes('-nostats'));
});

test('ffprobe JSON is unchanged and receives no progress flags',async()=>{
 const c=child();let call;const events=[];const media=harness((...args)=>{call=args;return c;});
 const pending=media.__run('ffprobe',['-of','json'],1000,{progressDuration:4,onProgress:p=>events.push(p)});
 c.stdout.write('{"format":{"duration":"4"}}');c.emit('close',0,null);
 assert.equal(await pending,'{"format":{"duration":"4"}}');assert.equal(call[0],'ffprobe');assert.equal(call[1].includes('-progress'),false);assert.equal(events.length,0);
});

test('abort targets only own group and waits for child close',async()=>{
 const c=child(54321),control=new AbortController();const media=harness(()=>c);let settled=false;
 const pending=media.__run('ffmpeg',[],1000,{signal:control.signal});pending.then(()=>settled=true,()=>settled=true);
 control.abort();await Promise.resolve();assert.equal(settled,false);assert.deepEqual(media.signals,[{pid:-54321,signal:'SIGTERM'}]);
 c.emit('close',null,'SIGTERM');await assert.rejects(pending,e=>e.code==='VIDEO_TASK_ABORTED'&&e.signal==='SIGTERM'&&e.exitCode===null);
});

test('an aborted child reporting exit0 remains aborted',async()=>{
 const c=child(),control=new AbortController(),media=harness(()=>c);const pending=media.__run('ffmpeg',[],1000,{signal:control.signal});
 control.abort();c.emit('close',0,null);await assert.rejects(pending,e=>e.code==='VIDEO_TASK_ABORTED');
});

test('timeout waits for killed child, reports timeout with signal',async()=>{
 const c=child(65432),media=harness(()=>c);let settled=false;const pending=media.__run('ffmpeg',[],5);pending.then(()=>settled=true,()=>settled=true);
 await new Promise(r=>setTimeout(r,15));assert.equal(settled,false);assert.deepEqual(media.signals,[{pid:-65432,signal:'SIGKILL'}]);
 c.emit('close',null,'SIGKILL');await assert.rejects(pending,e=>e.code==='VIDEO_TASK_TIMEOUT'&&e.signal==='SIGKILL');
});

test('blank stderr reports exit code rather than an empty failure',async()=>{
 const c=child(),media=harness(()=>c),pending=media.__run('ffmpeg',[],1000);c.emit('close',1,null);
 await assert.rejects(pending,e=>e.code==='MEDIA_PROCESS_FAILED'&&e.exitCode===1&&e.message.includes('退出码：1')&&e.message.includes('未返回诊断信息'));
});

test('failure captures warning diagnostics and terminating signal',async()=>{
 const c=child(),media=harness(()=>c),pending=media.__run('ffmpeg',[],1000);c.stderr.write('Error parsing NAL unit #0.');c.emit('close',null,'SIGSEGV');
 await assert.rejects(pending,e=>e.signal==='SIGSEGV'&&e.message.includes('Error parsing NAL unit #0.')&&e.message.includes('SIGSEGV'));
});

test('progress listener failure does not fail processing',async()=>{
 const c=child(),media=harness(()=>c),pending=media.__run('ffmpeg',[],1000,{progressDuration:2,onProgress(){throw Error('UI gone');}});
 c.stdout.write('out_time_us=1000000\n');c.emit('close',0,null);await pending;
});

test('abort during remux does not get swallowed and start fallback conversion',async()=>{
 const children=[],control=new AbortController();let removals=0;
 const fakeFs={...fs,promises:{...fs.promises,stat:async()=>({size:1000}),rm:async()=>{removals++;}}};
 const media=harness((command,args)=>{
   const c=child(40000+children.length);children.push(c);
   if(command==='ffprobe')queueMicrotask(()=>{c.stdout.write(JSON.stringify({format:{duration:'10',format_name:'mp4'},streams:[{codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',width:1280,height:720,duration:'10'}]}));c.emit('close',0,null);});
   return c;
 },fakeFs);
 const pending=media.processVideo('/fake/source','/fake/target',{signal:control.signal});
 while(children.length<2)await new Promise(r=>setTimeout(r,0));
 control.abort();children[1].emit('close',null,'SIGTERM');
 await assert.rejects(pending,e=>e.code==='VIDEO_TASK_ABORTED');
 assert.equal(children.length,2);assert.equal(removals,0);
});
