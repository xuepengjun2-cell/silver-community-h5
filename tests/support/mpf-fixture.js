'use strict';
const fs=require('node:fs'), path=require('node:path');
function mpfFixture(little = true, gapSize = 291) {
  const primary = fs.readFileSync(path.join(__dirname, '../fixtures/project-baseline.jpg'));
  const secondary = fs.readFileSync(path.join(__dirname, '../fixtures/project-progressive.jpg'));
  const tiff = Buffer.alloc(82);
  const u16 = (v, p) => little ? tiff.writeUInt16LE(v, p) : tiff.writeUInt16BE(v, p);
  const u32 = (v, p) => little ? tiff.writeUInt32LE(v, p) : tiff.writeUInt32BE(v, p);
  tiff.write(little ? 'II' : 'MM');u16(42, 2);u32(8, 4);u16(3, 8);
  u16(0xb000, 10);u16(7, 12);u32(4, 14);tiff.write('0100', 18);
  u16(0xb001, 22);u16(4, 24);u32(1, 26);u32(2, 30);
  u16(0xb002, 34);u16(7, 36);u32(32, 38);u32(50, 42);
  const segment = Buffer.alloc(90);segment.set([255, 226, 0, 88]);segment.write('MPF\0', 4);
  const primaryEnd = primary.length + segment.length, secondaryStart = primaryEnd + gapSize;
  u32(0x20030000, 50);u32(primaryEnd, 54);u32(0, 58);
  u32(0, 66);u32(secondary.length, 70);u32(secondaryStart - 10, 74);
  tiff.copy(segment, 8);
  const bytes = Buffer.concat([primary.subarray(0, 2), segment, primary.subarray(2), Buffer.alloc(gapSize, 0x5a), secondary]);
  const set16=(b,v,p)=>little?b.writeUInt16LE(v,10+p):b.writeUInt16BE(v,10+p);
  const set32=(b,v,p)=>little?b.writeUInt32LE(v,10+p):b.writeUInt32BE(v,10+p);
  return {bytes, primaryEnd, secondaryStart, set16, set32};
}
function cameraMpfFixture() {
  const f = mpfFixture(true, 0);
  const exif = Buffer.from('ffe1002245786966000049492a000800000001000f01020004000000444a490000000000', 'hex');
  const primary = Buffer.concat([f.bytes.subarray(0, 2), exif, f.bytes.subarray(2, f.primaryEnd)]);
  const secondary = f.bytes.subarray(f.secondaryStart);
  const secondaryStart = Math.ceil((primary.length + 2) / 4096) * 4096;
  const total = Math.ceil((secondaryStart + secondary.length) / 4096) * 4096;
  const bytes = Buffer.concat([primary, Buffer.alloc(secondaryStart - primary.length), secondary, Buffer.alloc(total - secondaryStart - secondary.length, 0x63)]);
  const tiff = 10 + exif.length;
  bytes.writeUInt32LE(secondaryStart - 2, tiff + 54);
  bytes.writeUInt32LE(secondaryStart - tiff, tiff + 74);
  return {bytes, primaryEnd: primary.length, secondaryStart, secondaryEnd: secondaryStart + secondary.length, tiff};
}
function sonyMpfFixture() {
  const f=mpfFixture(true,0);
  const tiff=Buffer.alloc(31);
  tiff.write('II');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(1,8);
  tiff.writeUInt16LE(0x10f,10);tiff.writeUInt16LE(2,12);tiff.writeUInt32LE(5,14);tiff.writeUInt32LE(26,18);tiff.write('SONY\0',26,'latin1');
  const exif=Buffer.alloc(10+tiff.length);exif.set([255,225]);exif.writeUInt16BE(exif.length-2,2);exif.write('Exif\0\0',4,'latin1');tiff.copy(exif,10);
  const primary=Buffer.concat([f.bytes.subarray(0,2),exif,f.bytes.subarray(2,f.primaryEnd)]), secondary=f.bytes.subarray(f.secondaryStart);
  const secondaryStart=Math.ceil((primary.length+3072)/512)*512,secondaryEnd=secondaryStart+secondary.length;
  const total=Math.ceil(secondaryEnd/32768)*32768, index=10+exif.length;
  const bytes=Buffer.concat([primary,Buffer.alloc(secondaryStart-primary.length),secondary,Buffer.alloc(total-secondaryEnd)]);
  bytes.writeUInt32LE(0xa0030000,index+50);bytes.writeUInt32LE(primary.length,index+54);
  bytes.writeUInt32LE(0x40010002,index+66);bytes.writeUInt32LE(secondaryStart-index,index+74);
  return {bytes,primaryEnd:primary.length,secondaryStart,secondaryEnd,tiff:index};
}
module.exports={mpfFixture,cameraMpfFixture,sonyMpfFixture};
