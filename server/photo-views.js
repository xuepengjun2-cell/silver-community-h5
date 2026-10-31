'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { run, probe } = require('./miniapp-media');
const { downloadVideo } = require('./video-delivery-io');
const MiB = 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const online = (url, size) => `${url}?x-tos-process=image/auto-orient,1/resize,m_lfit,w_${size},h_${size},limit_1/quality,q_82`;
function regularDirectory(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error('Unsafe photo staging directory');
}
async function photoResourcesAvailable(directory) {
  try {
    let available=os.freemem();
    if(process.platform==='linux') available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB/m)?.[1])*1024;
    const disk=await fs.promises.statfs(directory);
    return available>=768*MiB && os.loadavg()[0]<1.6 && Number(disk.bavail)*Number(disk.bsize)>=1280*MiB;
  } catch {return false;}
}
function storageIO(getStorage) {
  const signed=(key,method)=>{const {client,bucket}=getStorage();return client.getPreSignedUrl({bucket,key,method,expires:600});};
  return {
    async head(key,signal) {
      const response=await fetch(signed(key,'HEAD'),{method:'HEAD',signal});
      if(!response.ok) throw Object.assign(Error('Photo HEAD failed'),{code:response.status===404?'PHOTO_INVALID':'PHOTO_IO'});
      return {size:Number(response.headers.get('content-length')),etag:response.headers.get('etag')};
    },
    download:(key,file,size,signal)=>downloadVideo(signed(key,'GET'),file,size,50*MiB,{signal}),
    async upload(key,file,signal) {
      const bytes=await fs.promises.readFile(file);
      const response=await fetch(signed(key,'PUT'),{method:'PUT',signal,headers:{'Content-Type':/\.png$/.test(key)?'image/png':/\.webp$/.test(key)?'image/webp':'image/jpeg','Cache-Control':'public, max-age=31536000, immutable'},body:bytes});
      if(!response.ok)throw Error('Photo PUT failed');
      await response.body?.cancel();
    }
  };
}
async function renderPhoto(source,dir,signal,ext) {
  if(ext==='webp') {
    const h=Buffer.alloc(32);const fd=await fs.promises.open(source,'r');try{await fd.read(h,0,32,0);}finally{await fd.close();}
    if(h.toString('ascii',0,4)==='RIFF' && h.toString('ascii',8,12)==='WEBP' && h.toString('ascii',12,16)==='VP8X' && (h[20]&2))return {bypass:true};
  }
  const info=await probe(source,{signal});
  const picture=info.streams?.find(s=>s.codec_type==='video');
  if(!picture || picture.codec_name!==({jpg:'mjpeg',png:'png',webp:'webp'}[ext]) || !(picture.width>0 && picture.height>0) || picture.width*picture.height>64000000)throw Error('Photo exceeds decode bounds');
  const outputs=[];
  for(const size of [640,1600]){
    const file=path.join(dir,`${size}.${ext}`);
    await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-filter_threads','1','-threads','1','-max_alloc','268435456','-i',source,'-map','0:v:0','-frames:v','1','-threads','1','-vf',`scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`,...(ext==='png'?['-c:v','png']:ext==='webp'?['-c:v','libwebp','-quality','82']:['-c:v','mjpeg','-q:v','4']),'-y',file],60000,{signal});
    const out=await probe(file,{signal});const p=out.streams?.find(s=>s.codec_type==='video');
    const bytes=(await fs.promises.stat(file)).size;
    if(!p || p.width>size || p.height>size || !bytes || bytes>20*MiB)throw Error('Invalid photo derivative');
    outputs.push({size,file,ext});
  }
  return outputs;
}
function createPhotoViews(options) {
  const io=options.io || storageIO(options.getStorage);
  const render=options.render || renderPhoto;
  let stopped=false, active=null, timer=null;
  const queue=new Map(), entries={}, validated=new Map(), verified=new Set();
  const invalid=message=>Object.assign(Error(message),{code:"PHOTO_INVALID"});
  // Durable entries are hints until this process rechecks source and both objects.
  try {
    if(fs.lstatSync(options.stateFile).isSymbolicLink())throw Error('Unsafe sidecar');
    const saved=JSON.parse(fs.readFileSync(options.stateFile,'utf8'));
    if(saved.version===1 && saved.entries && typeof saved.entries==='object') for(const [key,value] of Object.entries(saved.entries)) if(/^[a-f0-9]{64}$/.test(key) && value && typeof value==='object') entries[key]=value;
  }catch {}
  function persist() {
    regularDirectory(path.dirname(options.stateFile));
    if(fs.existsSync(options.stateFile) && fs.lstatSync(options.stateFile).isSymbolicLink())throw Error('Unsafe sidecar');
    const tmp=`${options.stateFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd;
    try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({version:1,entries}));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,options.stateFile);const d=fs.openSync(path.dirname(tmp),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
    finally{if(fd!==undefined && fd!==null)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  }
  function source(media) {
    if(media?.type!=='image')return null;
    const ref=options.resolveSource(media);
    if(!ref || /[?#]/.test(ref.url) || !/\.(jpe?g|png|webp)$/i.test(ref.key))return null;
    return ref;
  }
  function schedule(delay=0) {
    if(stopped || timer || active || !queue.size)return;
    timer=setTimeout(()=>{timer=null;void pump().catch(error=>console.error("[photo-views]",error.code || error.name));},delay);timer.unref?.();
  }
  function request(media) {
    const ref=source(media);if(!ref || stopped)return;
    const id=digest(ref.url),saved=entries[id];
    if(active?.id===id || validated.get(id)>Date.now() || saved?.retryAt>Date.now())return;
    if(queue.size<128)queue.set(id,{...media});
    if(verified.has(id) && timer){clearTimeout(timer);timer=null;}
    schedule();
  }
  function decorate(media) {
    if(media?.type!=='image')return {...media};
    const {thumbnailUrl,previewUrl,imageViewState,...dto}=media;
    const ref=source(dto);if(!ref)return dto;
    if(dto.size>0 && dto.size<=20*MiB && !/\.webp$/i.test(ref.key))return {...dto,thumbnailUrl:online(ref.url,640),previewUrl:online(ref.url,1600),imageViewState:'ready'};
    const id=digest(ref.url),saved=entries[id];request(dto);
    if(saved?.state==='online' && validated.get(id)>Date.now())return {...dto,thumbnailUrl:online(ref.url,640),previewUrl:online(ref.url,1600),imageViewState:'ready'};
    if(saved?.state==='original' && validated.has(id))return {...dto,thumbnailUrl:ref.url,previewUrl:ref.url,imageViewState:'ready'};
    if(saved?.state==='ready' && validated.has(id))return {...dto,thumbnailUrl:saved.outputs[0].url,previewUrl:saved.outputs[1].url,imageViewState:'ready'};
    return {...dto,imageViewState:saved?.state==='unavailable'?'unavailable':'pending'};
  }
  async function pump() {
    if(stopped || active || !queue.size)return;
    const [id,media]=[...queue.entries()].find(([key])=>verified.has(key)) || queue.entries().next().value;
    // The claim covers the asynchronous guard too, preventing parallel pumps.
    const controller=new AbortController();const job={id,controller,done:null};active=job;
    let scheduleAfter=false;
    job.done=(async()=>{
      let dir,deadline,release;
      const previous=entries[id];
      try {
        const signal=controller.signal, ref=source(media);
        deadline=setTimeout(()=>controller.abort(),180000);deadline.unref?.();
        const check=async()=>{if(signal.aborted || !ref || !await options.isReferenced(media))throw invalid('Photo source no longer referenced');};
        // Already verified immutable objects need only identity HEADs, not codec resources.
        if(verified.has(id) && ['ready','original'].includes(previous?.state)) {
          queue.delete(id);await check();
          const before=await io.head(ref.key,signal);
          const revision=digest(`${ref.url}\n${before.etag}\n${before.size}\nphoto-v1`);
          if(revision===previous.revision) {
            for(const output of previous.outputs || []) {
              const head=await io.head(output.key,signal);
              if(head.size!==output.bytes || !head.etag || head.etag!==output.etag)throw invalid('Derivative identity changed');
            }
            const after=await io.head(ref.key,signal);await check();
            if(before.etag!==after.etag || before.size!==after.size)throw invalid('Photo source changed');
            delete previous.retryAt;delete previous.attempts;
            validated.set(id,Date.now()+15000);return;
          }
          verified.delete(id);validated.delete(id);queue.set(id,media);
        }
        if(!await options.canRun()) {scheduleAfter=true;return;}
        if(stopped)return;
        queue.delete(id);
        await check();
        if(options.reserve) release=await options.reserve();
        await check();
        regularDirectory(options.stagingRoot);
        dir=fs.mkdtempSync(path.join(options.stagingRoot,`${id.slice(0,16)}-`));
        fs.writeFileSync(path.join(dir,'active.json'),JSON.stringify({pid:process.pid,id}),{flag:'wx',mode:0o600});
        const before=await io.head(ref.key,signal);
        if(!before.etag || !Number.isSafeInteger(before.size) || before.size<=0 || before.size>50*MiB)throw Error('Photo size or ETag unavailable');
        if(before.size<=20*MiB && !/\.webp$/i.test(ref.key)) {
          await check();entries[id]={state:'online',size:before.size,etag:before.etag};persist();validated.set(id,Date.now()+15000);return;
        }
        const revision=digest(`${ref.url}\n${before.etag}\n${before.size}\nphoto-v1`);
        const prefix=ref.key.slice(0,ref.key.lastIndexOf('/')+1);
        const urlPrefix=ref.url.slice(0,ref.url.lastIndexOf('/')+1);
        const ext=/\.png$/i.test(ref.key)?'png':/\.webp$/i.test(ref.key)?'webp':'jpg';
        const expected=[640,1600].map(size=>({key:`${prefix}photo-views/${revision}-${size}.${ext}`,url:`${urlPrefix}photo-views/${revision}-${size}.${ext}`}));
        async function verify(outputs) {
          for(let i=0;i<2;i++){
            const output=outputs[i];if(!output || output.key!==expected[i].key || output.url!==expected[i].url || !/^[a-f0-9]{64}$/.test(output.sha256) || !Number.isSafeInteger(output.bytes) || output.bytes<=0 || output.bytes>20*MiB)throw invalid('Invalid cached derivative');
            const head=await io.head(output.key,signal);if(head.size!==output.bytes || !head.etag)throw invalid('Derivative HEAD mismatch');
            output.etag=head.etag;
            const file=path.join(dir,`readback-${i}`);
            try {
              await io.download(output.key,file,head.size,signal);
              if(digest(await fs.promises.readFile(file))!==output.sha256)throw invalid('Derivative readback mismatch');
            } finally {
              // A failed cached readback must not block this job's repair: the
              // downloader exclusively creates its destination with wx.
              await fs.promises.rm(file,{force:true});
            }
          }
        }
        let outputs;
        if(previous?.state==='ready' && previous.revision===revision && previous.outputs?.length===2){try{await verify(previous.outputs);outputs=previous.outputs;}catch(error){if(signal.aborted || error.code!=='PHOTO_INVALID')throw error;}}
        if(!outputs){
          const input=path.join(dir,`source.${ext}`);await io.download(ref.key,input,before.size,signal);
          await check();
          const made=await render(input,dir,signal,ext);
          if(made.bypass) {
            const after=await io.head(ref.key,signal);await check();
            if(before.etag!==after.etag || before.size!==after.size)throw invalid('Photo source changed');
            entries[id]={state:'original',revision};persist();verified.add(id);validated.set(id,Date.now()+15000);return;
          }
          if(made.length!==2 || made[0].size!==640 || made[1].size!==1600)throw Error('Incomplete derivative pair');
          outputs=[];
          for(let i=0;i<2;i++){
            await check();
            const bytes=await fs.promises.readFile(made[i].file);if(!bytes.length || bytes.length>20*MiB)throw Error('Derivative size limit');
            await io.upload(expected[i].key,made[i].file,signal);
            outputs.push({...expected[i],bytes:bytes.length,sha256:digest(bytes)});
          }
          await verify(outputs);
        }
        const after=await io.head(ref.key,signal);await check();
        if(before.etag!==after.etag || before.size!==after.size)throw Error('Photo source changed');
        entries[id]={state:'ready',revision,outputs};persist();verified.add(id);validated.set(id,Date.now()+15000);
      }catch(error){
        validated.delete(id);
        const attempts=Math.min(6,(entries[id]?.attempts||0)+1);
        if(error.code==='PHOTO_INVALID')verified.delete(id);
        const retryAt=Date.now()+Math.min(3600000,30000*2**(attempts-1));
        entries[id]=previous && ['ready','original'].includes(previous.state) && error.code!=='PHOTO_INVALID'
          ? {...previous,attempts,retryAt} : {state:'unavailable',attempts,retryAt};
        try{persist();}catch{}
      }finally{
        clearTimeout(deadline);
        // Only this run's freshly-created directory is eligible for cleanup.
        try { if(dir)await fs.promises.rm(dir,{recursive:true,force:true}); } finally { release?.(); }
      }
    })();
    try{await job.done;}finally{active=null;schedule(scheduleAfter?15000:0);}
  }
  return {decorate,request,isBusy:()=>Boolean(active),async stop(){stopped=true;clearTimeout(timer);queue.clear();active?.controller.abort();await active?.done;}};
}
module.exports={createPhotoViews,photoResourcesAvailable,renderPhoto};
