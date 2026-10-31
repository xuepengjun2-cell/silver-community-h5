const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let createPhotoViews;
try { ({ createPhotoViews } = require('../server/photo-views')); } catch {}
const base='https://images.example/photos/';
function fixture(t, extra={}) {
  assert.equal(typeof createPhotoViews,'function','photo view service is implemented');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-views-'));
  const service=createPhotoViews({stateFile:path.join(dir,'views.json'),stagingRoot:path.join(dir,'staging'),resolveSource:m=>m.url?.startsWith(base)?{key:'photos/'+m.url.slice(base.length),url:m.url}:null,isReferenced:()=>true,canRun:async()=>false,...extra});
  t.after(async()=>{await service.stop(); fs.rmSync(dir,{recursive:true,force:true});});
  return {service,dir};
}
test('small raster DTO uses stable 640/1600 URLs without mutating source or trusting injected derivative fields',t=>{
 const {service}=fixture(t); const m={type:'image',url:base+'a.jpg',size:20*1024*1024,thumbnailUrl:'https://evil.test/x'}; const before=JSON.stringify(m); const dto=service.decorate(m);
 assert.equal(dto.url,m.url); assert.equal(dto.thumbnailUrl,base+'a.jpg?x-tos-process=image/auto-orient,1/resize,m_lfit,w_640,h_640,limit_1/quality,q_82'); assert.match(dto.previewUrl,/w_1600,h_1600/); assert.equal(dto.imageViewState,'ready');assert.equal(JSON.stringify(m),before);
});
test('oversize and unknown-size images remain pending; unsupported URLs never inherit injected view fields',t=>{
 const {service}=fixture(t);
 for(const size of [undefined,0,20*1024*1024+1]){const dto=service.decorate({type:'image',url:base+'a.jpg',size}); assert.equal(dto.imageViewState,'pending');assert.equal(dto.previewUrl,undefined);}
 for(const url of [base+'a.gif',base+'a.svg','https://evil.test/a.jpg']){const dto=service.decorate({type:'image',url,size:4,previewUrl:'https://evil.test/fake',imageViewState:'ready'});assert.equal(dto.imageViewState,undefined);assert.equal(dto.previewUrl,undefined);}
});
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('worker did not settle');};
function worker(t, overrides={}) {
 let etag='original-1', referenced=true, allowed=true, renders=0; const objects=new Map();
 const io={head:async key=>key==='photos/a.jpg'?{size:21*1024*1024,etag}:{size:objects.get(key)?.length,etag:'out'}, download:async(key,file)=>fs.writeFileSync(file,key==='photos/a.jpg'?'original':objects.get(key)),upload:async(key,file)=>objects.set(key,fs.readFileSync(file))};
 const f=fixture(t,{canRun:async()=>allowed,isReferenced:()=>referenced,io,render:async(source,dir)=>{renders++;const outputs=[];for(const size of [640,1600]){const file=path.join(dir,`${size}.jpg`);fs.writeFileSync(file,`render ${size}`);outputs.push({size,file,ext:'jpg'});}return outputs;},...overrides});
 return {...f,io,objects,media:{type:'image',url:base+'a.jpg',size:21*1024*1024},replace:()=>{etag='original-2';},remove:()=>{referenced=false;},allow:v=>{allowed=v;},renders:()=>renders};
}
test('queue deduplicates; publishes only verified pair; persists independent sidecar and cleans own staging',async t=>{
 const w=worker(t); for(let i=0;i<8;i++)w.service.request(w.media);
 await wait(()=>w.service.decorate(w.media).imageViewState==='ready');
 await wait(()=>!w.service.isBusy());
 assert.equal(w.renders(),1);assert.equal(w.objects.size,2);assert.match(w.service.decorate(w.media).previewUrl,/photo-views/);assert.equal(fs.readdirSync(path.join(w.dir,'staging')).length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir,'views.json'))).version,1);
});
test('busy guard postpones and does not create staging; stop cancels pending work',async t=>{
 const w=worker(t);w.allow(false);w.service.request(w.media);await new Promise(r=>setTimeout(r,40));assert.equal(w.renders(),0);assert.equal(fs.existsSync(path.join(w.dir,'staging')),false);await w.service.stop();assert.equal(w.service.isBusy(),false);
});
test('source replacement and reference removal during render never publish ready',async t=>{
 for(const mutation of ['replace','remove']){let w;w=worker(t,{render:async()=>{w[mutation]();throw Error('source changed');}});w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='unavailable');assert.equal(w.objects.size,0);}
});
test('partial upload failure never publishes one derivative as ready',async t=>{
 let uploaded=0; const w=worker(t,{io:{head:async()=>({size:21*1024*1024,etag:'original'}),download:async(_key,file)=>fs.writeFileSync(file,'original'),upload:async()=>{if(++uploaded===2)throw Error('failed');}}});w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='unavailable');assert.equal(w.service.decorate(w.media).previewUrl,undefined);
});
test('stop aborts its own in-flight renderer and waits until its staging is cleaned',async t=>{
 let started=false;const w=worker(t,{render:async(_source,_dir,signal)=>{started=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}});
 w.service.request(w.media);await wait(()=>started);await w.service.stop();assert.equal(w.service.isBusy(),false);assert.equal(fs.readdirSync(path.join(w.dir,'staging')).length,0);assert.equal(w.service.decorate(w.media).previewUrl,undefined);
});
test('changed ETag after successful render fences final publication',async t=>{
 let w;w=worker(t,{render:async(_source,dir)=>{const out=[640,1600].map(size=>{const file=path.join(dir,size+'.jpg');fs.writeFileSync(file,'derivative');return {size,file,ext:'jpg'};});w.replace();return out;}});
 w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='unavailable');assert.equal(w.objects.size,2);assert.equal(w.service.decorate(w.media).previewUrl,undefined);
});
test('source >50MiB is rejected before downloading or rendering',async t=>{
 const w=worker(t,{io:{head:async()=>({size:50*1024*1024+1,etag:'large'}),download:async()=>{throw Error('must not download');}}});w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='unavailable');assert.equal(w.renders(),0);assert.equal(w.objects.size,0);
});
test('corrupt sidecar cannot publish injected derivatives and orphan staging remains untouched',async t=>{
 const {service,dir}=fixture(t);await service.stop();fs.writeFileSync(path.join(dir,'views.json'),'{corrupt');fs.mkdirSync(path.join(dir,'staging'));fs.writeFileSync(path.join(dir,'staging','old-orphan'),'keep');
 const recovered=createPhotoViews({stateFile:path.join(dir,'views.json'),stagingRoot:path.join(dir,'staging'),resolveSource:m=>({key:'photos/a.jpg',url:m.url}),isReferenced:()=>true,canRun:async()=>false});
 assert.equal(recovered.decorate({type:'image',url:base+'a.jpg'}).imageViewState,'pending');await recovered.stop();assert.equal(fs.readFileSync(path.join(dir,'staging','old-orphan'),'utf8'),'keep');
});
test('unknown size uses HEAD to choose online transforms when actual source is within 20MiB',async t=>{
 const w=worker(t,{io:{head:async()=>({size:3000,etag:'small'})}});const media={...w.media,size:0};w.service.request(media);await wait(()=>w.service.decorate(media).imageViewState==='ready');assert.match(w.service.decorate(media).previewUrl,/x-tos-process=/);assert.equal(w.renders(),0);await wait(()=>!w.service.isBusy());assert.equal(fs.readdirSync(path.join(w.dir,'staging')).length,0);
});
test('worker holds and releases shared disk lease even on render failure',async t=>{
 let held=false,releases=0;const w=worker(t,{reserve:async()=>{held=true;return ()=>{held=false;releases++;};},render:async()=>{assert.equal(held,true);throw Error('decode failed');}});w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='unavailable');await wait(()=>!w.service.isBusy());assert.equal(held,false);assert.equal(releases,1);
});
test('restart revalidates source and both readbacks before reusing durable derivatives',async t=>{
 const w=worker(t);w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');await w.service.stop();
 let rendered=0;const recovered=createPhotoViews({stateFile:path.join(w.dir,'views.json'),stagingRoot:path.join(w.dir,'staging'),resolveSource:m=>({key:'photos/a.jpg',url:m.url}),isReferenced:()=>true,canRun:async()=>true,io:w.io,render:async()=>{rendered++;throw Error('unexpected regenerate');}});
 t.after(()=>recovered.stop());assert.equal(recovered.decorate(w.media).imageViewState,'pending');await wait(()=>recovered.decorate(w.media).imageViewState==='ready');assert.equal(rendered,0);await recovered.stop();
});
test('video thumbnail metadata is preserved byte-for-byte',t=>{const {service}=fixture(t);const video={type:'video',url:'https://example/a.mp4',thumbnailUrl:'https://example/poster.jpg',size:9000};assert.deepEqual(service.decorate(video),video);});
test('same-length corrupted cached output repairs in the same job with exclusive readback files',async t=>{
 const w=worker(t);w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');await w.service.stop();
 const firstKey=[...w.objects.keys()][0],original=w.objects.get(firstKey);w.objects.set(firstKey,Buffer.alloc(original.length,120));
 const io={...w.io,download:async(key,file)=>fs.writeFileSync(file,key==='photos/a.jpg'?'original':w.objects.get(key),{flag:'wx'})};
 let renders=0;const recovered=createPhotoViews({stateFile:path.join(w.dir,'views.json'),stagingRoot:path.join(w.dir,'staging'),resolveSource:m=>({key:'photos/a.jpg',url:m.url}),isReferenced:()=>true,canRun:async()=>true,io,render:async(_source,dir)=>{renders++;return [640,1600].map(size=>{const file=path.join(dir,size+'.jpg');fs.writeFileSync(file,`render ${size}`);return {size,file,ext:'jpg'};});}});
 t.after(()=>recovered.stop());recovered.request(w.media);await wait(()=>['ready','unavailable'].includes(recovered.decorate(w.media).imageViewState));assert.equal(recovered.decorate(w.media).imageViewState,'ready');assert.equal(renders,1);assert.deepEqual(w.objects.get(firstKey),original);await recovered.stop();
});
test('verified pair refreshes by HEAD while video busy and survives transient IO without regeneration',async t=>{
 const w=worker(t);let downloads=0,heads=0,fail=false;const head=w.io.head,download=w.io.download;
 w.io.head=async(...args)=>{heads++;if(fail)throw Error('temporary network');return head(...args);};w.io.download=async(...args)=>{downloads++;return download(...args);};
 w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');await wait(()=>!w.service.isBusy());
 const realNow=Date.now;let now=realNow();Date.now=()=>now;t.after(()=>{Date.now=realNow;});w.allow(false);const baseline=downloads;heads=0;now+=16000;
 assert.equal(w.service.decorate(w.media).imageViewState,'ready');await wait(()=>heads>=3&&!w.service.isBusy());assert.equal(downloads,baseline);
 fail=true;now+=16000;w.service.request(w.media);await wait(()=>!w.service.isBusy()&&heads>3);await new Promise(r=>setTimeout(r,20));
 assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(w.dir,'views.json'))).entries)[0].state,'ready');
 fail=false;now+=61000;w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');assert.equal(downloads,baseline);assert.equal(w.renders(),1);
 w.replace();now+=16000;w.service.request(w.media);await new Promise(r=>setTimeout(r,30));assert.equal(w.service.decorate(w.media).previewUrl,undefined);assert.equal(w.renders(),1);
});
test('ready revalidation is not starved behind a resource-blocked new image',async t=>{
 const w=worker(t);w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');await wait(()=>!w.service.isBusy());
 const realNow=Date.now;Date.now=()=>realNow()+16000;t.after(()=>{Date.now=realNow;});w.allow(false);
 let heads=0;const head=w.io.head;w.io.head=async(...args)=>{heads++;return head(...args);};
 w.service.request({...w.media,url:base+'new.jpg'});w.service.request(w.media);await wait(()=>heads>=4);assert.equal(w.renders(),1);
});
test('restart transient readback preserves pair and retries without original download',async t=>{
 const w=worker(t);w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');await w.service.stop();
 let fail=true,originalDownloads=0;const io={...w.io,download:async(key,...args)=>{if(key==='photos/a.jpg')originalDownloads++;if(fail)throw Error('transient readback');return w.io.download(key,...args);}};
 const recovered=createPhotoViews({stateFile:path.join(w.dir,'views.json'),stagingRoot:path.join(w.dir,'staging'),resolveSource:m=>({key:'photos/a.jpg',url:m.url}),isReferenced:()=>true,canRun:async()=>true,io,render:async()=>{throw Error('must reuse');}});t.after(()=>recovered.stop());
 recovered.request(w.media);await new Promise(r=>setTimeout(r,40));assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(w.dir,'views.json'))).entries)[0].state,'ready');assert.equal(recovered.decorate(w.media).previewUrl,undefined);
 fail=false;const realNow=Date.now;Date.now=()=>realNow()+61000;t.after(()=>{Date.now=realNow;});recovered.request(w.media);await wait(()=>recovered.decorate(w.media).imageViewState==='ready');assert.equal(originalDownloads,0);
});
test('restart regenerates legacy JPEG recipe even with intact source and derivative identities',async t=>{
 const w=worker(t);w.service.request(w.media);await wait(()=>w.service.decorate(w.media).imageViewState==='ready');await w.service.stop();
 const file=path.join(w.dir,'views.json'),saved=JSON.parse(fs.readFileSync(file)),entry=Object.values(saved.entries)[0];
 const legacy=require('node:crypto').createHash('sha256').update(`${w.media.url}\noriginal-1\n${21*1024*1024}\nphoto-v1`).digest('hex');
 entry.outputs=entry.outputs.map(output=>{const key=output.key.replace(entry.revision,legacy),url=output.url.replace(entry.revision,legacy);w.objects.set(key,w.objects.get(output.key));return {...output,key,url};});entry.revision=legacy;fs.writeFileSync(file,JSON.stringify(saved));
 let renders=0;const recovered=createPhotoViews({stateFile:file,stagingRoot:path.join(w.dir,'staging'),resolveSource:m=>({key:'photos/a.jpg',url:m.url}),isReferenced:()=>true,canRun:async()=>true,io:w.io,render:async(_source,dir)=>{renders++;return [640,1600].map(size=>{const file=path.join(dir,size+'.jpg');fs.writeFileSync(file,'new recipe');return {size,file,ext:'jpg'};});}});t.after(()=>recovered.stop());
 recovered.request(w.media);await wait(()=>recovered.decorate(w.media).imageViewState==='ready');assert.equal(renders,1);
});
