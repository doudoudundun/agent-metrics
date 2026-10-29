const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {_electron,expect}=require('@playwright/test');
const root=path.resolve(__dirname,'..'),profile=path.join(root,'.verify-native-profile');
if(fs.existsSync(path.join(profile,'desktop-host.json')))fs.unlinkSync(path.join(profile,'desktop-host.json'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const helper=path.join(root,'dist/native',JSON.parse(fs.readFileSync(path.join(root,'dist/native/manifest.json'),'utf8')).executable);
(async()=>{
 const env={...process.env,AGENT_METRICS_CARD_USER_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'dist/main.js')],env});
 try{
  const page=await app.firstWindow();
  let attached;
  for(let i=0;i<50;i++){
   try{attached=JSON.parse(fs.readFileSync(path.join(profile,'desktop-host.json'),'utf8'));if(attached.attached)break;}catch{}
   await pause(100);
  }
  console.log('attachment',JSON.stringify(attached));
  expect(attached?.attached).toBe(true);
  const inspect=async()=>{
   const window=await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],h=w.getNativeWindowHandle();return {pid:process.pid,handle:h.length===8?h.readBigUInt64LE().toString():h.readUInt32LE().toString(),electronBounds:w.getBounds(),visible:w.isVisible(),topmost:w.isAlwaysOnTop(),displays:screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,scaleFactor:d.scaleFactor}))}});
   const r=spawnSync(helper,[window.handle,String(window.pid),'inspect'],{windowsHide:true,encoding:'utf8'});
   if(r.status!==0)throw Error(r.stderr||'Inspection failed');
   return {...window,native:JSON.parse(r.stdout)};
  };
  const initial=await inspect();
  expect(initial.native.attached).toBe(true);expect(initial.native.visible).toBe(true);
  const wrongOwner=spawnSync(helper,[initial.handle,String(initial.pid+1),'inspect'],{windowsHide:true,encoding:'utf8'});
  expect(wrongOwner.status).toBe(3);
  console.log('initial',JSON.stringify(initial));
  const target=await app.evaluate(({BrowserWindow,screen})=>{
   const window=BrowserWindow.getAllWindows()[0];
   const displays=screen.getAllDisplays();
   const display=displays.find(d=>d.id!==screen.getPrimaryDisplay().id)||screen.getPrimaryDisplay();
   const current=window.getBounds();
   const dip={x:display.workArea.x+Math.max(0,Math.floor((display.workArea.width-current.width)/2)),y:display.workArea.y+Math.max(0,Math.min(300,display.workArea.height-current.height)),width:current.width,height:current.height};
   return {dip,pixel:screen.dipToScreenRect(null,dip)};
  });
  const reposition=spawnSync(helper,[initial.handle,String(initial.pid),'position',...['x','y','width','height'].map(k=>String(target.pixel[k]))],{windowsHide:true,encoding:'utf8'});
  expect(reposition.status).toBe(0);
  await pause(200);
  const moved=await inspect();console.log('moved',JSON.stringify(moved));
  expect(moved.native.attached).toBe(true);
  expect(moved.electronBounds.x).toBe(target.dip.x);expect(moved.native.bounds.x).toBe(target.pixel.x);
  await app.evaluate(({screen})=>screen.emit('display-metrics-changed',screen.getPrimaryDisplay(),['workArea']));
  await pause(150);
  const afterDisplayChange=await inspect();
  expect(afterDisplayChange.native.bounds.x).toBe(target.pixel.x);
  await expect(page.locator('#scope-label')).toHaveText('Today');
  await page.evaluate(()=>document.body.style.backgroundColor='#000');
  await page.screenshot({path:path.join(root,'evidence/desktop-attached-2026-10-29.png')});
  fs.writeFileSync(path.join(root,'evidence/desktop-host-2026-10-29.json'),JSON.stringify({attached,initial,moved,afterDisplayChange,wrongOwnerRejected:true},null,2));
 }finally{
  await app.close();
  if(fs.existsSync(profile)){
   const resolved=fs.realpathSync(profile);
   if(path.dirname(resolved)!==fs.realpathSync(root)||path.basename(resolved)!=='.verify-native-profile')throw Error('Unexpected verification profile path');
   fs.rmSync(profile,{recursive:true,force:true});
  }
 }
})().catch(e=>{console.error(e);process.exitCode=1});
