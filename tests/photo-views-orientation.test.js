const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {jpegOrientation}=require('../server/photo-views');
function jpeg(orientation,big=false) {
 const t=Buffer.alloc(26);t.write(big?'MM':'II');const u16=(v,p)=>big?t.writeUInt16BE(v,p):t.writeUInt16LE(v,p),u32=(v,p)=>big?t.writeUInt32BE(v,p):t.writeUInt32LE(v,p);
 u16(42,2);u32(8,4);u16(1,8);u16(0x112,10);u16(3,12);u32(1,14);u16(orientation,18);
 const exif=Buffer.concat([Buffer.from('Exif\0\0'),t]),marker=Buffer.from([255,225,0,0]);marker.writeUInt16BE(exif.length+2,2);return Buffer.concat([Buffer.from([255,216]),marker,exif,Buffer.from([255,218])]);
}
test('bounded JPEG EXIF parser reads all orientations/endian forms and real EXIF6/8 fixtures',()=>{
 assert.equal(typeof jpegOrientation,'function');
 for(const big of [false,true])for(let n=1;n<=8;n++)assert.equal(jpegOrientation(jpeg(n,big)),n);
 for(const n of [6,8])assert.equal(jpegOrientation(fs.readFileSync(path.join(__dirname,`fixtures/photo-views/orientation-${n}.jpg`))),n);
 for(const bytes of [Buffer.alloc(0),Buffer.from([255,216]),jpeg(9),jpeg(6).subarray(0,22)])assert.equal(jpegOrientation(bytes),1);
 const badOffset=jpeg(6);badOffset.writeUInt32LE(0xffffffff,16);assert.equal(jpegOrientation(badOffset),1);
 const badCount=jpeg(6);badCount.writeUInt32LE(0xffffffff,26);assert.equal(jpegOrientation(badCount),1);
 const segment=Buffer.alloc(65537);segment.set([255,224,255,255]);assert.throws(()=>jpegOrientation(Buffer.concat([Buffer.from([255,216]),...Array(17).fill(segment)])),/scan bound/);
});
test('actual JPEG renderer disables implicit rotation and applies explicit EXIF transform before scale',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-orientation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];
 const ctx={module:{exports:{}},require:name=>name==='./miniapp-media'?{probe:async()=>({streams:[{codec_type:'video',codec_name:'mjpeg',width:80,height:40}]}),run:async(_cmd,args)=>{calls.push(args);fs.writeFileSync(args.at(-1),'output');}}:name==='./video-delivery-io'?{}:require(name)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server/photo-views.js'),'utf8'),{...ctx,Buffer});
 const filters=['','hflip','hflip,vflip','vflip','transpose=0','transpose=1','transpose=3','transpose=2'];
 for(let n=1;n<=8;n++){
  const input=path.join(dir,'source.jpg');fs.writeFileSync(input,jpeg(n));calls.length=0;
  await ctx.module.exports.renderPhoto(input,dir,new AbortController().signal,'jpg');assert.equal(calls.length,2);
  for(const args of calls){assert.ok(args.indexOf('-noautorotate')>=0&&args.indexOf('-noautorotate')<args.indexOf('-i'));const vf=args[args.indexOf('-vf')+1];assert.ok(vf.startsWith((filters[n-1]?filters[n-1]+',':'')+'scale='));assert.equal(args[args.indexOf('-map_metadata')+1],'-1');}
 }
});
