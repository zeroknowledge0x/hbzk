import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Encoder} from '../src/stream.js';

test('record-only encoder cannot include an RTMP target even when keys are configured',()=>{
 const encoder=new Encoder({width:1280,height:720,fps:30,sampleRate:22050,bitrate:'3500k',recordOnly:true,rtmpUrl:'rtmps://example.invalid/live',streamKey:'test-key'});
 assert.equal(encoder.outputTarget(),null);
});
test('npm start and host scripts reference existing runtime entrypoints',()=>{
 const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
 for(const key of ['start','host']){
  const entry=pkg.scripts[key].match(/node\s+(\S+)/)?.[1];
  assert.ok(entry&&fs.existsSync(entry),`${key} points at missing ${entry}`);
 }
});
