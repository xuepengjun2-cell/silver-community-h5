const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {renderPhoto}=require('../server/photo-views');
const {run,probe}=require('../server/miniapp-media');
const available=spawnSync('ffmpeg',['-version']).status===0;
test('real PNG derivatives preserve alpha and fit 640/1600 without upscaling', {skip:!available && !process.env.CI},async t=>{
 assert.equal(available,true,'Linux CI must provide FFmpeg');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-codec-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'original.png');
 await run('ffmpeg',['-f','lavfi','-i','color=red:s=2000x1000','-vf','format=rgba,colorchannelmixer=aa=0.5','-frames:v','1','-threads','1',source],60000);
 const outputs=await renderPhoto(source,dir,new AbortController().signal,'png');
 for(const [i,w] of [640,1600].entries()) {const info=await probe(outputs[i].file);assert.equal(info.streams[0].width,w);assert.equal(info.streams[0].height,w/2);assert.match(info.streams[0].pix_fmt,/rgba|argb|bgra|yuva|ya/);}
 assert.ok(fs.existsSync(source));
});
// Actual binary fixtures are generated with Pillow, not decoder mocks: raw JPEG
// quadrant layout is red/green over blue/yellow, with only EXIF6 or EXIF8 changed.
for(const [orientation,colors] of [[6,[[0,0,255],[255,0,0],[255,255,0],[0,255,0]]],[8,[[0,255,0],[255,255,0],[255,0,0],[0,0,255]]]]) {
 test(`real JPEG EXIF${orientation} rotates both dimensions and pixels once`,{skip:!available && !process.env.CI},async t=>{
  assert.equal(available,true,'Linux CI must provide FFmpeg');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-exif-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(__dirname,'fixtures/photo-views',`orientation-${orientation}.jpg`),original=fs.readFileSync(source);
  const outputs=await renderPhoto(source,dir,new AbortController().signal,'jpg');
  for(const output of outputs){
   const info=await probe(output.file);assert.equal(info.streams[0].width,40);assert.equal(info.streams[0].height,80);
   const raw=path.join(dir,`pixels-${output.size}.rgb`);
   await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',output.file,'-frames:v','1','-threads','1','-pix_fmt','rgb24','-f','rawvideo',raw],60000);
   const pixels=fs.readFileSync(raw);assert.equal(pixels.length,40*80*3);
   for(const [i,[x,y]] of [[10,20],[30,20],[10,60],[30,60]].entries())for(let c=0;c<3;c++)assert.ok(Math.abs(pixels[(y*40+x)*3+c]-colors[i][c])<45,`EXIF${orientation} output${output.size} quadrant${i} channel${c}`);
  }
  assert.deepEqual(fs.readFileSync(source),original);
 });
}
test('real static WebP generates two previews and animated WebP never flattens to a preview',{skip:!available && !process.env.CI},async t=>{
 assert.equal(available,true,'Linux CI must provide FFmpeg');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-webp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fixture=name=>path.join(__dirname,'fixtures/photo-views',name);
 const outputs=await renderPhoto(fixture('static.webp'),dir,new AbortController().signal,'webp');assert.equal(outputs.length,2);
 for(const output of outputs){const info=await probe(output.file);assert.equal(info.streams[0].codec_name,'webp');assert.equal(info.streams[0].width,80);assert.equal(info.streams[0].height,40);fs.unlinkSync(output.file);}
 await assert.rejects(renderPhoto(fixture('animated.webp'),dir,new AbortController().signal,'webp'));
 assert.deepEqual(fs.readdirSync(dir),[]);
});
