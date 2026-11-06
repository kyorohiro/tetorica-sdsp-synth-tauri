// Exercise the packaged frontend and actual WASM/AudioWorklets with a mocked
// desktop IPC host. Speakers stay muted; this does not test a CPAL device.
const {chromium, webkit} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const nativeSource = require('node:fs').readFileSync(path.join(root,'src-tauri/src/audio.rs'),'utf8');
const nativeCredits = Number(/const QUEUE_PACKETS: usize = (\d+);/.exec(nativeSource)[1]);
const nativePrefillPackets = Number(/const PREFILL_PACKETS: usize = (\d+);/.exec(nativeSource)[1]);
const options = {out:path.join(root,'docs/desktop_browser_20261106.json'), screenshots:null};
for(let index=2;index<process.argv.length;index++) {
  const name=process.argv[index].replace(/^--/,'');
  assert(Object.hasOwn(options,name),`Unknown option: ${name}`);
  assert(process.argv[index+1],`Missing value: ${name}`);
  options[name]=path.resolve(process.argv[++index]);
}
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
  '.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
// Self-authored two-voice BRR snapshot; no game music, samples or IPL ROM.
function spc() {
  const bytes=Buffer.alloc(0x10200),ram=bytes.subarray(0x100,0x10100),dsp=bytes.subarray(0x10100,0x10180);
  bytes.write('SNES-SPC700 Sound File Data v0.30',0,'ascii');
  bytes[0x21]=bytes[0x22]=bytes[0x23]=0x1a;bytes[0x24]=30;
  bytes.write('Desktop PMON snapshot',0x2e,32,'ascii');bytes.write('Tetorica authored fixture',0x4e,32,'ascii');
  dsp[0x5d]=0x20;
  const mod=Buffer.from([0xc0,0x77,0x66,0x44,0x22,0x0e,0xcc,0xaa,0x99,0xc3,0x99,0xaa,0xcc,0xee,0x02,0x44,0x66,0x77]);
  const carrier=Buffer.from([0xb0,0x17,0x35,0x53,0x71,0x0f,0xdb,0x97,0x53,0xb3,0x31,0x75,0x79,0xbd,0xff,0xdb,0x97,0x53]);
  for(const [src,start,data]of[[3,0x3000,mod],[5,0x3100,carrier]]){
    data.copy(ram,start);ram.writeUInt16LE(start,0x2000+src*4);ram.writeUInt16LE(start+9,0x2002+src*4);
  }
  for(let ch=0;ch<8;ch++){
    const at=ch<<4;dsp[at]=16;dsp[at+1]=24;dsp[at+3]=16;dsp[at+4]=5;dsp[at+5]=0x8f;dsp[at+6]=0xe0;dsp[at+7]=80;
  }
  dsp[0]=20;dsp[1]=244;dsp[3]=8;dsp[4]=3;dsp[5]=0;dsp[6]=0;dsp[7]=96;
  dsp[0x13]=12;dsp[0x18]=64;dsp[0x19]=16;dsp[0x2d]=2;dsp[0x4d]=3;
  dsp[0x6d]=0x90;dsp[0x7d]=3;dsp[0x0d]=216;dsp[0x2c]=48;dsp[0x3c]=232;
  [100,20,-10,5,0,0,0,0].forEach((value,index)=>{dsp[0x0f+index*16]=value&255;});
  return bytes;
}
function wav() {
  const rate=44100,frames=rate,bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(Math.sin(i/rate*Math.PI*440)*16000),44+i*2);
  return bytes;
}

async function run(name, engine, backend) {
  const browser=await engine.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});
  page.setDefaultTimeout(15000);
  const errors=[], missing=[], consoleErrors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  const desktop=await fs.readFile(path.join(root,'desktop/desktop-interface.js'),'utf8');
  const audio=await fs.readFile(path.join(root,'desktop/audio-interface.js'),'utf8');
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['blob:','data:'].includes(url.protocol)) return route.continue();
    if(url.hostname!=='tauri.localhost') {missing.push(url.href);return route.abort();}
    try {
      const file=url.pathname==='/desktop-audio-worklet.js' ? path.join(root,'desktop/audio-worklet.js')
        :path.resolve(root,'dist','.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      let body=await fs.readFile(file);
      if(url.pathname==='/synth-snes/synth.js') body=Buffer.concat([body,Buffer.from('\n;\n'+audio)]);
      return route.fulfill({status:200,body,contentType:mime[path.extname(file)]||'application/octet-stream',
        headers:{'access-control-allow-origin':'*'}});
    } catch(error) {missing.push(`${url.pathname}: ${error.message}`);return route.fulfill({status:404,body:'Missing asset'});}
  });
  await page.addInitScript(({backend,nativeCredits})=>{
    const audit=window.desktopAudit={calls:[],saves:[],contexts:[],worklets:[],speakerEdges:new Map(),
      pinned:false,nextRead:0,packets:0,returned:0,nativePeak:0,nativeFinite:true,nativeSession:0,failWrites:false,holdStart:false,cancelSave:false};
    const Context=window.AudioContext??window.webkitAudioContext, Node=window.AudioWorkletNode;
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    window.AudioContext=class extends Context {constructor(...args){
      super(...args);audit.contexts.push(this);
      // Playwright page routes do not see AudioWorklet module fetches. Serve
      // those exact bytes through a real CORS-enabled loopback test server.
      const add=this.audioWorklet.addModule.bind(this.audioWorklet);
      this.audioWorklet.addModule=(url,...options)=>{
        const value=new URL(url,location.href);
        return add(value.hostname==='tauri.localhost'?new URL(value.pathname+value.search,backend).href:url,...options);
      };
    }};
    if(window.webkitAudioContext) window.webkitAudioContext=window.AudioContext;
    window.AudioWorkletNode=class extends Node {constructor(...args){super(...args);audit.worklets.push({node:this,name:args[1]});}};
    AudioNode.prototype.connect=function(destination,...args){
      if(destination!==this.context.destination) return connect.call(this,destination,...args);
      const analyser=this.context.createAnalyser();analyser.fftSize=4096;
      const mute=this.context.createGain();mute.gain.value=0;
      connect.call(this,analyser);connect.call(analyser,mute);connect.call(mute,destination);
      audit.speakerEdges.set(this,{analyser,mute});return destination;
    };
    AudioNode.prototype.disconnect=function(destination,...args){
      const edge=audit.speakerEdges.get(this);
      if(edge&&(arguments.length===0||destination===this.context.destination)) {
        disconnect.call(this,edge.analyser);disconnect.call(edge.analyser);disconnect.call(edge.mute);audit.speakerEdges.delete(this);
        if(arguments.length) return;
      }
      return arguments.length?disconnect.call(this,destination,...args):disconnect.call(this);
    };
    audit.read=()=>new Promise((resolve,reject)=>{
      const node=audit.worklets.find(entry=>entry.name==='tetorica-sdsp-synth')?.node;
      if(!node) return reject(Error('No synth worklet'));
      const id=--audit.nextRead,timer=setTimeout(()=>{node.port.removeEventListener('message',receive);reject(Error('Read timed out'));},5000);
      function receive({data}) {if(data.id!==id)return;clearTimeout(timer);node.port.removeEventListener('message',receive);data.error?reject(Error(data.error)):resolve(data.value);}
      node.port.addEventListener('message',receive);node.port.start();node.port.postMessage({id,method:'read',args:[]});
    });
    audit.webPeak=async()=>{
      const {output}=await window.tetoricaSynthAudio.ensureReady(),edge=audit.speakerEdges.get(output);
      if(!edge)return 0;const samples=new Float32Array(edge.analyser.fftSize);edge.analyser.getFloatTimeDomainData(samples);
      return samples.reduce((peak,value)=>Math.max(peak,Math.abs(value)),0);
    };
    window.__TAURI_INTERNALS__={invoke:async(command,args={},options)=>{
      audit.calls.push({command,session:args?.session,bytes:args instanceof ArrayBuffer?args.byteLength:null});
      if(command==='window_pin_state')return audit.pinned;
      if(command==='set_window_pin')return audit.pinned=args.pinned;
      if(command==='save_export_binary') {
        const length=new DataView(args).getUint32(0,true),header=JSON.parse(new TextDecoder().decode(new Uint8Array(args,4,length)));
        const bytes=new Uint8Array(args,4+length),text=new TextDecoder().decode(bytes);
        audit.saves.push({header,text,bytes:[...bytes]});return audit.cancelSave?null:'/tmp/'+header.filename;
      }
      if(command==='audio_devices')return [{id:'offline-test',name:'Offline test device',isDefault:true}];
      if(command==='audio_start') {
        if(audit.holdStart)await new Promise(resolve=>{audit.releaseStart=()=>{audit.holdStart=false;resolve();};});
        return {session:`offline-${++audit.nativeSession}`,frames:512,credits:nativeCredits,sampleRate:48000};
      }
      if(command==='audio_stop')return null;
      if(command==='audio_write') {
        if(audit.failWrites)throw Error('Injected offline device failure');
        const samples=new Float32Array(args);audit.packets+=args.byteLength/(512*8);
        for(const value of samples){audit.nativeFinite&&=Number.isFinite(value);audit.nativePeak=Math.max(audit.nativePeak,Math.abs(value));}
        return {rustMicros:100,serviceMicros:200};
      }
      if(command==='audio_poll') {
        await new Promise(resolve=>setTimeout(resolve,20));const credits=Math.min(nativeCredits,audit.packets-audit.returned);audit.returned+=credits;
        return {credits,queuedFrames:1024,underruns:0};
      }
      if(command==='reload_window')return null;
      throw Error(`Unexpected native command: ${command}`);
    }};
  },{backend,nativeCredits});
  await page.addInitScript({content:desktop});
  const state=()=>page.evaluate(()=>window.desktopAudit.read());
  const wait=async predicate=>{
    let value;for(let index=0;index<100;index++){value=await state();if(predicate(value))return value;await page.waitForTimeout(25);}
    throw Error('State did not settle: '+JSON.stringify(value));
  };
  const menu=async()=>{if(!await page.locator('#synthMenu').evaluate(node=>node.open))await page.click('#synthMenuButton');};
  const panel=async(id,open=true)=>{
    const node=page.locator(`#${id}`);
    if(await node.evaluate(node=>node.open)!==open)await page.locator(`#${id} > summary`).click();
    await page.waitForFunction(({id,open})=>document.getElementById(id).open===open,{id,open});
  };
  const source=async value=>{
    await page.click(`#source [data-choice-value="${value}"]`);
    await wait(state=>state.preset.source===value);
    assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.matches('input,select,textarea'))),false,'source choices leave performance keys available');
  };
  const audition=async()=>{
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.waitForFunction(async()=>await window.desktopAudit.webPeak()>.0001);
    await page.keyboard.up('a');await wait(value=>value.voices.length===0);
  };
  const importPreset=async(preset,name='desktop-sdsp.json')=>{
    await menu();const chooser=page.waitForEvent('filechooser');await page.click('#loadPreset');
    await(await chooser).setFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(preset))});
    await wait(value=>value.preset.name===preset.name&&value.preset.source===preset.source);
  };
  const radio=(id,value)=>page.locator(`#${id} [data-choice-value="${value}"]`);
  const presetView=preset=>{
    const shown=structuredClone(preset);
    if(shown.brr?.data)delete shown.brr.data;
    if(shown.pmon?.brr?.data)delete shown.pmon.brr.data;
    return shown;
  };
  const savePreset=async()=>{
    const before=await page.evaluate(()=>window.desktopAudit.saves.length);
    await menu();await page.click('#savePreset');
    await page.waitForFunction(count=>window.desktopAudit.saves.length===count+1,before);
    return JSON.parse(await page.evaluate(()=>window.desktopAudit.saves.at(-1).text));
  };
  try {
    console.log(`CHECK ${name}: S-DSP desktop toolbar / Pin / lazy audio`);
    await page.goto(backend+'/index.html');
    await page.waitForFunction(()=>window.tetoricaSynthAudio&&document.querySelector('#synthPinButton')?.hidden===false&&document.querySelector('#desktop-audio-native'));
    assert.equal(await page.title(),'Tetorica S-DSP Synth');
    assert.match(await page.locator('#synthTitle').textContent(),/Tetorica\s+S-DSP Synth/);
    assert.equal(await page.locator('#loadPreset').textContent(),'Instrument · S-DSP preset…');
    assert.equal(await page.evaluate(()=>window.desktopAudit.contexts.length),0);
    await page.click('#synthPinButton');await page.waitForFunction(()=>document.querySelector('#synthPinButton').getAttribute('aria-pressed')==='true');
    await page.click('#synthPinButton');await page.waitForFunction(()=>document.querySelector('#synthPinButton').getAttribute('aria-pressed')==='false');
    await page.click('#startAudio');await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent.startsWith('Audio ready'));
    await audition();
    const wavePreset=await savePreset();assert.equal(wavePreset.version,5);assert.equal(wavePreset.format,'tetorica-sdsp-voice');
    assert.equal(await page.evaluate(()=>window.desktopAudit.saves[0].header.filename),'sdsp-voice.json');
    await page.locator('#masterVolume').evaluate(node=>{node.value='3.8';node.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.locator('#masterVolumeValue').textContent(),'380%');assert.equal(await page.locator('#masterVolume').getAttribute('data-boosted'),'true');
    await page.locator('#masterVolume').evaluate(node=>{node.value='.7';node.dispatchEvent(new Event('input',{bubbles:true}));});
    console.log(`CHECK ${name}: eight hardware Wave voices, Noise clock and four paired PMON notes`);
    const waveKeys=['a','s','d','f','g','h','j','k'];for(const key of waveKeys)await page.keyboard.down(key);
    let current=await wait(value=>value.voices.length===8);assert.equal(current.capacity,8);
    for(const key of waveKeys)await page.keyboard.up(key);await wait(value=>value.voices.length===0);
    await source('noise');await page.keyboard.down('a');current=await wait(value=>value.voices.length===1);assert.equal(current.noiseRegisters.non,255);
    const noiseOwner=current.voices[0].id,noiseGeneration=current.generation;
    await page.locator('[data-stepper-for="noiseClock"][data-stepper-delta="-1"]').click();
    current=await wait(value=>value.preset.noise.clock===30);assert.equal(current.voices[0].id,noiseOwner);assert.equal(current.generation,noiseGeneration);
    assert.equal(await page.isDisabled('#pitchBend'),true);await page.keyboard.up('a');await wait(value=>value.voices.length===0);
    await source('wave');await panel('pmonSection');await page.check('#pmonEnabled');await wait(value=>value.capacity===4);
    for(const key of waveKeys.slice(0,4))await page.keyboard.down(key);
    current=await wait(value=>value.voices.length===4);assert.equal(current.pmonRegisters.mask,0xaa);
    assert.deepEqual(current.voices.map(voice=>voice.channel),[1,3,5,7]);assert.deepEqual(current.voices.map(voice=>voice.modulatorChannel),[0,2,4,6]);
    const stolen=current.voices[0].id;await page.keyboard.down('g');await wait(value=>value.voices.length===4&&!value.voices.some(voice=>voice.id===stolen));
    await page.keyboard.up('a');assert.equal((await state()).voices.length,4);
    for(const key of ['s','d','f','g'])await page.keyboard.up(key);await wait(value=>value.voices.length===0);
    await page.check('#echoEnabled');await wait(value=>value.preset.echo.enabled);await audition();
    const pmonWavePreset=await savePreset();assert(pmonWavePreset.pmon.enabled&&pmonWavePreset.echo.enabled);
    console.log(`CHECK ${name}: held pairs and Pitch reset / new notes blocked during output switch`);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.locator('#pitchBend').evaluate(node=>{node.value='1';node.dispatchEvent(new Event('input',{bubbles:true}));});await wait(value=>value.pitch===1);
    await menu();await panel('desktop-audio-output');
    await page.evaluate(()=>{window.desktopAudit.holdStart=true;});await page.click('#desktop-audio-native');
    await page.waitForFunction(()=>typeof window.desktopAudit.releaseStart==='function');
    await wait(value=>value.voices.length===0&&value.pitch===0);
    await page.keyboard.down('s');assert.equal((await state()).voices.length,0);await page.keyboard.up('s');
    await page.evaluate(()=>window.desktopAudit.releaseStart());await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.keyboard.up('a');await page.click('#desktop-audio-web');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent==='Web Audio output');await audition();
    console.log(`CHECK ${name}: native save / reload / preset / audio chooser cancellation`);
    await page.evaluate(()=>{window.desktopAudit.cancelSave=true;});await menu();await page.click('#savePreset');
    await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent==='Save cancelled.');
    await page.evaluate(()=>{window.desktopAudit.cancelSave=false;});
    await menu();await page.click('[data-reset-offline-cache]');await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.desktopAudit.calls.filter(call=>call.command==='reload_window').length),0);
    const beforeCancel=(await state()).preset;
    for(const button of ['loadPreset','synthMenuAudioImport','synthMenuBrrImport']){
      await menu();const chooser=page.waitForEvent('filechooser');await page.click('#'+button);await(await chooser).setFiles([]);
      assert.deepEqual((await state()).preset,beforeCancel);await audition();
    }
    await importPreset({...wavePreset,name:'Desktop Wave'});await audition();
    const canvas=page.locator('#waveCanvas');await canvas.scrollIntoViewIfNeeded();const rect=await canvas.boundingBox();assert(rect);
    await page.keyboard.down('a');const beforeEdit=await wait(value=>value.voices.length===1);
    await page.mouse.move(rect.x+rect.width*.2,rect.y+rect.height*.35);await page.mouse.down();
    await page.mouse.move(rect.x+rect.width*.75,rect.y+rect.height*.65,{steps:6});
    assert.deepEqual((await state()).voices,beforeEdit.voices);await page.mouse.up();
    current=await wait(value=>value.voices.length===0&&JSON.stringify(value.preset.wave)!==JSON.stringify(beforeEdit.preset.wave));
    assert.equal(current.preset.wave.length,128);await page.keyboard.up('a');await audition();
    console.log(`CHECK ${name}: Menu BRR / WAV and SPC PMON pair import with captured tuning and Echo`);
    const raw=Buffer.from([0xc0,0x77,0x66,0x44,0x22,0x0e,0xcc,0xaa,0x99,0xc3,0x99,0xaa,0xcc,0xee,0x02,0x44,0x66,0x77]);
    await menu();let chooser=page.waitForEvent('filechooser');await page.click('#synthMenuBrrImport');
    await(await chooser).setFiles({name:'desktop-loop.brr',mimeType:'application/octet-stream',buffer:raw});
    await wait(value=>value.preset.source==='brr'&&value.preset.brr.name==='desktop-loop.brr');await audition();
    await menu();chooser=page.waitForEvent('filechooser');await page.click('#synthMenuAudioImport');
    await(await chooser).setFiles({name:'desktop-test.wav',mimeType:'audio/wav',buffer:wav()});
    await wait(value=>value.preset.source==='brr'&&value.preset.brr.name==='desktop-test.wav');await audition();
    const audioPreset=await savePreset();assert(Buffer.from(audioPreset.brr.data,'base64').length>18);
    await page.locator('#spcSection').evaluate(node=>{node.open=false;});await menu();chooser=page.waitForEvent('filechooser');await page.click('#synthMenuSpc');
    await(await chooser).setFiles({name:'desktop-pair.spc',mimeType:'application/octet-stream',buffer:spc()});
    await page.waitForFunction(()=>document.querySelector('#spcMetadata').textContent.includes('desktop-pair.spc'));
    assert.equal(await page.locator('#spcSection').evaluate(node=>node.open),true);
    assert.equal(await page.isChecked('#spcIncludePmon'),false);await page.check('#spcIncludePmon');await page.check('#spcIncludeEcho');
    await page.click('#spcCandidate1');current=await wait(value=>value.pmon.active&&value.preset.pmon.source==='brr'&&value.preset.pmon.brr.basePitch===2048);
    const rootKey=await page.locator('#keyboard .key:not([disabled])').evaluateAll(nodes=>nodes.find(node=>/(?:^|\s)C4(?:\s|$)/.test(node.textContent))?.dataset.key);assert(rootKey);
    await page.keyboard.down(rootKey);current=await wait(value=>value.voices.length===1);
    assert.equal(current.registers[0][2]|current.registers[0][3]<<8,2048);assert.equal(current.registers[1][2]|current.registers[1][3]<<8,3072);
    assert.deepEqual(current.registers[0].slice(0,2),[0,0]);assert.equal(current.echoRegisters.eon,0xaa);await page.keyboard.up(rootKey);
    const pairPreset=await savePreset();assert.equal(Buffer.from(pairPreset.brr.data,'base64').length,18);assert.equal(Buffer.from(pairPreset.pmon.brr.data,'base64').length,18);
    await radio('waveTarget','modulator').click();assert.equal(await canvas.getAttribute('data-editable'),'false');
    assert.equal(await page.locator('#voiceEditor canvas').count(),1);
    await menu();chooser=page.waitForEvent('filechooser');await page.click('#synthMenuBrrImport');await(await chooser).setFiles([]);
    assert.deepEqual((await state()).preset,presetView(pairPreset));await radio('waveTarget','carrier').click();
    await importPreset({...pairPreset,name:'Restored desktop pair'});await audition();
    console.log(`CHECK ${name}: public output bridge stops all sources and preserves both paired BRR assets`);
    for(const [kind,original,count]of[['Wave',wavePreset,8],['Noise',{...wavePreset,source:'noise'},8],['Wave PMON',pmonWavePreset,4],['BRR',audioPreset,8],['BRR PMON',pairPreset,4]]){
      const preset={...structuredClone(original),name:'Switch test '+kind};await importPreset(preset);
      const pressed=waveKeys.slice(0,count);for(const key of pressed)await page.keyboard.down(key);
      const playing=await wait(value=>value.voices.length===count);
      await page.waitForFunction(async()=>await window.desktopAudit.webPeak()>.0001);
      if(!await page.isDisabled('#pitchBend')){await page.locator('#pitchBend').evaluate(node=>{node.value='.5';node.dispatchEvent(new Event('input',{bubbles:true}));});await wait(value=>value.pitch===.5);}
      await page.evaluate(async()=>{window.tetoricaSynthAudio.setSwitching(true);await window.tetoricaSynthAudio.stopPlayback();});
      current=await wait(value=>value.voices.length===0&&value.pitch===0);assert.deepEqual(current.preset,playing.preset);
      for(const id of ['pitchBend','keyboardPitchBend'])assert.equal(await page.locator('#'+id).inputValue(),'0');
      await page.waitForFunction(async()=>await window.desktopAudit.webPeak()<.00001);
      await page.keyboard.down('z');assert.equal((await state()).voices.length,0);await page.keyboard.up('z');
      await page.evaluate(()=>window.tetoricaSynthAudio.setSwitching(false));for(const key of pressed)await page.keyboard.up(key);await audition();
    }
    console.log(`CHECK ${name}: actual native-capture PCM / route switch / failure fallback keep the pair and master monitor`);
    const nativePreset={...pairPreset,name:'Native paired BRR'};await importPreset(nativePreset);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);await menu();await panel('desktop-audio-output');
    await page.click('#desktop-audio-native');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,presetView(nativePreset));await page.keyboard.up('a');
    assert.equal(await page.evaluate(async()=>window.desktopAudit.speakerEdges.has((await window.tetoricaSynthAudio.ensureReady()).output)),false);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);await page.waitForFunction(()=>window.desktopAudit.nativePeak>.001&&window.desktopAudit.packets>0);
    assert.equal(await page.evaluate(()=>window.desktopAudit.nativeFinite),true);
    await page.click('#desktop-audio-web');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent==='Web Audio output');
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,presetView(nativePreset));await page.keyboard.up('a');
    assert.equal(await page.evaluate(async()=>window.desktopAudit.speakerEdges.has((await window.tetoricaSynthAudio.ensureReady()).output)),true);await audition();
    await page.click('#desktop-audio-native');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.evaluate(()=>{window.desktopAudit.failWrites=true;});await page.keyboard.down('a');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.includes('Injected offline device failure'));
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,presetView(nativePreset));await page.keyboard.up('a');await audition();
    const retainedPair=await savePreset();assert.equal(retainedPair.brr.data,pairPreset.brr.data);assert.equal(retainedPair.pmon.brr.data,pairPreset.pmon.brr.data);
    assert.equal(await page.evaluate(()=>window.desktopAudit.contexts.length),1);
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}.png`),fullPage:true});
    await page.setViewportSize({width:390,height:900});await page.waitForTimeout(120);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,`Narrow desktop overflow: ${overflow}`);
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}-narrow.png`),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
    const measurements=await page.evaluate(()=>({nativePackets:window.desktopAudit.packets,nativePeak:window.desktopAudit.nativePeak,nativeFinite:window.desktopAudit.nativeFinite}));
    console.log(`PASS ${name}: mocked desktop host with actual S-DSP WASM and capture Worklet`);
    return {engine:name,desktopToolbar:true,pin:true,nativePresetBinarySave:true,reloadCancel:true,spcMenuChooser:true,
      presetFileImport:true,keyboardAfterMenus:true,nativeCapturePcm:true,switchPreservesPreset:true,nativeFailureFallback:true,
      switchStopsAllSourcesAndPitch:true,switchBlocksPerformance:true,nativeSaveCancel:true,presetLoadCancel:true,
      presetV5:true,spcPmonPairImport:true,capturedPitches:[2048,3072],waveDrawing:true,brrMenuImport:true,
      wavMenuImport:true,audioImportCancelKeepsSound:true,embeddedDualBrrSave:true,allSourcesQuiesce:true,eightWaveVoices:true,eightNoiseVoices:true,fourPmonPairs:true,
      oneAudioContext:true,mobileOverflow:overflow,nativeCredits,nativePrefillPackets,mockedDeviceRate:48000,...measurements,pageErrors:errors,missingAssets:missing,
      nativeHost:'mocked Tauri IPC; no CPAL device',physicalOutput:'muted'};
  } catch(error) {
    console.error(JSON.stringify({engine:name,audioStatus:await page.locator('#audioStatus').textContent().catch(()=>null),errors,missing,consoleErrors}));
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}-failure.png`),fullPage:true}).catch(()=>{});
    throw error;
  } finally {await browser.close();}
}
(async()=>{
  if(options.screenshots)await fs.mkdir(options.screenshots,{recursive:true});
  const server=http.createServer(async(request,response)=>{
    try {
      const name=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file=name==='/desktop-audio-worklet.js'?path.join(root,'desktop/audio-worklet.js'):path.resolve(root,'dist','.'+name);
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      const bytes=await fs.readFile(file);response.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','access-control-allow-origin':'*'});response.end(bytes);
    } catch(error){response.writeHead(404,{'access-control-allow-origin':'*'});response.end('Missing test asset');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const backend=`http://tauri.localhost:${server.address().port}`;
    const rows=[];for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])rows.push(await run(name,engine,backend));
    await fs.mkdir(path.dirname(options.out),{recursive:true});await fs.writeFile(options.out,JSON.stringify({passed:true,rows},null,2)+'\n');
    console.log(`Desktop browser check passed: ${options.out}`);
  } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
