import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { ZstdFrameValidator } from '../../scripts/zstd-frame-validator.js';
import { readTranscriptBuffer, transcriptStream } from '../../scripts/transcript-file.js';
const opts = { skip: typeof zlib.zstdCompressSync !== 'function' };
function validate(bytes, chunk = bytes.length || 1) {
  const v = new ZstdFrameValidator();
  for (let i = 0; i < bytes.length; i += chunk) v.write(bytes.subarray(i, i + chunk));
  v.finish();
}
const skipFrame = Buffer.from([80,42,77,24,3,0,0,0,1,2,3]);
test('complete, concatenated and skippable frames survive every header boundary', opts, () => {
  for (const input of [Buffer.alloc(0), Buffer.from('hello world'), Buffer.alloc(300000,65)]) {
    for (const flag of [0,1]) {
      const frame = zlib.zstdCompressSync(input,{params:{[zlib.constants.ZSTD_c_checksumFlag]:flag}});
      for (const chunk of [1,2,3,7,65536]) {
        validate(frame,chunk); validate(Buffer.concat([skipFrame,frame,frame,skipFrame]),chunk);
      }
      for (let cut=0;cut<frame.length;cut++) assert.throws(()=>validate(frame.subarray(0,cut),1));
    }
  }
  for(let cut=0;cut<skipFrame.length;cut++) assert.throws(()=>validate(skipFrame.subarray(0,cut)));
});
test('raw, RLE, absent content size and invalid framing', () => {
  validate(Buffer.from([40,181,47,253,32,5,43,0,0,65]),1);
  validate(Buffer.from([40,181,47,253,0,0,25,0,0,65,66,67]),1);
  assert.throws(()=>validate(Buffer.alloc(8)),/magic/);
  assert.throws(()=>validate(Buffer.from([40,181,47,253,8])),/Reserved/);
});
test('sync and stream readers preserve large multiblock data and reject truncation', opts, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zstd-guard-'));
  const file=path.join(dir,'fixture.jsonl.zst');
  const content=randomBytes(300000).toString('hex');
  const frame=zlib.zstdCompressSync(Buffer.from(content));
  const read=async()=>{let out='';for await(const part of transcriptStream(file))out+=part;return out;};
  try {
    fs.writeFileSync(file,frame);
    assert.equal(readTranscriptBuffer(file).toString(),content);
    assert.equal(await read(),content);
    // Consumer cancellation must not leave the pipeline running.
    const cancelled=transcriptStream(file);
    for await(const part of cancelled){assert.ok(part.length);break;}
    assert.equal(cancelled.destroyed,true);
    for(const cut of [0,1,5,40,Math.floor(frame.length/2),frame.length-1]) {
      fs.writeFileSync(file,frame.subarray(0,cut));
      assert.throws(()=>readTranscriptBuffer(file),{code:'TRANSCRIPT_COMPRESSED'});
      await assert.rejects(read(),{code:'TRANSCRIPT_COMPRESSED'});
    }
    fs.writeFileSync(file,Buffer.concat([frame,frame.subarray(0,5)]));
    await assert.rejects(read(),{code:'TRANSCRIPT_COMPRESSED'});
    assert.throws(()=>readTranscriptBuffer(file),{code:'TRANSCRIPT_COMPRESSED'});
    fs.rmSync(file);
    await assert.rejects(read(),{code:'ENOENT'});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
