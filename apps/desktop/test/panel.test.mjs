import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
 static async create() {
  const dom=new JSDOM(pug.renderFile('ui/index.pug'),{runScripts:'outside-only',pretendToBeVisual:true});
  const calls=[];const callbacks={};const pending=[];
  const style=dom.window.document.createElement('style');style.textContent=await readFile('ui/panel.css','utf8');dom.window.document.head.append(style);
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  dom.window.__TAURI__={core:{invoke:async(name,args)=>{calls.push({name,args});if(name==='initialize')return{config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},theme:{os:'linux'},settings:false,accessibility:false,input_monitoring:false,empty:false};if(name==='search')return new Promise(resolve=>pending.push({query:args.query,resolve}));if(name==='libraries')return[];if(name==='prepare_template')return{fields:[],steps:[{kind:'text',text:'Literal'}],text:'Literal',enter_actions:0,template:{text:'Literal',variables:{}}};return null;}},event:{listen:(name,callback)=>{callbacks[name]=callback;}}};
  dom.window.eval((await readFile('ui/panel.js','utf8')).replace('new Panel();','window.panel = new Panel();'));
  await new Promise(resolve=>setTimeout(resolve,0));
  return {dom,panel:dom.window.panel,calls,pending,callbacks};
 }
 static hit(id){return{id,library:'one',revision:2,library_name:'Personal',title:'Title '+id,abbreviation:id,preview:'<b>literal</b>\n\tCode'};}
}

test('stale search cannot insert an old result; Enter waits for current query',async()=>{
 const f=await Fixture.create();try {
  f.panel.query.value='old';const old=f.panel.search(0);f.pending[0].resolve([Fixture.hit('old')]);await old;
  f.panel.query.value='new';f.panel.query.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.panel.rows.length,0);
  f.panel.insert();await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(!f.calls.some(call=>call.name==='insert'));
  const request=f.pending.find(item=>item.query==='new');request.resolve([Fixture.hit('new')]);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.calls.find(call=>call.name==='insert').args.hit.id,'new');
  assert.equal(f.dom.window.document.querySelector('.result-preview').textContent,'<b>literal</b>\n\tCode');
  assert.equal(f.dom.window.document.querySelector('.result-preview b'),null);
 }finally{f.dom.window.close();}
});
test('late responses are ignored; keyboard selection, Copy and Escape use explicit commands',async()=>{
 const f=await Fixture.create();try{
  const old=f.panel.search(0);f.panel.sequence=1;const next=f.panel.search(1);
  f.pending[1].resolve([Fixture.hit('one'),Fixture.hit('two')]);await next;
  f.pending[0].resolve([Fixture.hit('stale')]);await old;assert.equal(f.panel.rows[0].id,'one');
  f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown'}));
  f.dom.window.document.querySelector('#copy').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.calls.find(call=>call.name==='copy_snippet').args.hit.id,'two');
  f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape'}));
  assert.ok(f.calls.some(call=>call.name==='dismiss'));
 }finally{f.dom.window.close();}
});

test('one result click inserts the clicked snippet',async()=>{
 const f=await Fixture.create();try{
  const search=f.panel.search(f.panel.sequence);f.pending[0].resolve([Fixture.hit('one'),Fixture.hit('two')]);await search;
  f.panel.list.children[1].click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.calls.find(call=>call.name==='insert').args.hit.id,'two');
 }finally{f.dom.window.close();}
});

test('settings mode reaches native focus policy from tray and Back',async()=>{
 const f=await Fixture.create();try{
  await f.panel.settings(true);
  assert.equal(f.calls.filter(call=>call.name==='set_settings_view').at(-1).args.enabled,true);
  assert.equal(f.dom.window.document.querySelector('#settings-view').hidden,false);
  await f.panel.settings(false);
  assert.equal(f.calls.filter(call=>call.name==='set_settings_view').at(-1).args.enabled,false);
  await f.panel.open({settings:true,theme:{os:'linux'}});
  assert.equal(f.calls.filter(call=>call.name==='set_settings_view').at(-1).args.enabled,true);
 }finally{f.dom.window.close();}
});

test('missing insertion target hint stays out of search and settings',async()=>{
 const f=await Fixture.create();try{
	await f.panel.open({settings:false,theme:{os:'windows'},status:'Choose another application first'});
	assert.equal(f.panel.status.textContent,'');
	await f.panel.open({settings:true,theme:{os:'windows'},status:'Choose another app first'});
	assert.equal(f.panel.status.textContent,'');
	f.panel.invoke=async(name)=>name==='initialize'?{config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},theme:{os:'macos'},settings:true,accessibility:true,input_monitoring:true,status:'Choose an application to insert into'}:null;
	f.dom.window.document.body.dataset.os='macos';f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await new Promise(resolve=>setTimeout(resolve,0));
	assert.equal(f.panel.status.textContent,'');
 }finally{f.dom.window.close();}
});

test('empty desktop offers sync, web app and TUI with the production server default',async()=>{
 const f=await Fixture.create();try{
	const value={settings:false,theme:{os:'linux'},config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},accessibility:true,input_monitoring:true,empty:true};f.panel.configure(value);await f.panel.open(value);
	assert.equal(f.dom.window.document.querySelector('#empty-state').hidden,false);
	assert.match(f.dom.window.document.querySelector('#empty-state').textContent,/no snippets yet/);
	assert.equal(f.dom.window.document.querySelector('#hint').hidden,true);
	assert.equal(f.dom.window.document.querySelector('#server').value,'https://app.typerelay.com');
	f.dom.window.document.querySelector('#empty-web').click();await new Promise(resolve=>setTimeout(resolve,0));f.dom.window.document.querySelector('#empty-tui').click();await new Promise(resolve=>setTimeout(resolve,0));
	assert.ok(f.calls.some(call=>call.name==='open_web_app'));
	assert.ok(f.calls.some(call=>call.name==='open_tui'));
	f.dom.window.document.querySelector('#empty-sync').click();await new Promise(resolve=>setTimeout(resolve,0));
	assert.equal(f.dom.window.document.body.dataset.view,'settings');
	assert.equal(f.dom.window.document.querySelector('#settings-sync').hidden,false);
	f.panel.configure({...value,empty:false});assert.equal(f.dom.window.document.querySelector('#empty-state').hidden,true);
 }finally{f.dom.window.close();}
});

test('macOS settings expose missing permissions and bundled TUI actions',async()=>{
 const f=await Fixture.create();try{
	await f.panel.open({settings:true,theme:{os:'macos'},config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},accessibility:false,input_monitoring:false});
  f.dom.window.document.querySelector('#open-accessibility').click();await new Promise(resolve=>setTimeout(resolve,0));
  f.dom.window.document.querySelector('#open-input-monitoring').click();await new Promise(resolve=>setTimeout(resolve,0));
  f.dom.window.document.querySelector('#open-tui').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(f.calls.some(call=>call.name==='open_accessibility_settings'));
  assert.ok(f.calls.some(call=>call.name==='open_input_monitoring_settings'));
  assert.ok(f.calls.some(call=>call.name==='open_tui'));
	assert.equal(f.dom.window.document.querySelector('#accessibility-state').textContent,'Required');
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-state').textContent,'Required');
	assert.equal(f.dom.window.document.querySelector('#accessibility-card').hidden,false);
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-card').hidden,false);
	assert.ok(f.dom.window.document.querySelector('#input-monitoring-card').compareDocumentPosition(f.dom.window.document.querySelector('#accessibility-card'))&f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.equal(f.dom.window.document.body.dataset.os,'macos');
	assert.equal(f.dom.window.document.body.dataset.view,'settings');
	f.dom.window.document.querySelector('[data-settings-tab="sync"]').click();
	assert.equal(f.dom.window.document.querySelector('#settings-general').hidden,true);
	assert.equal(f.dom.window.document.querySelector('#settings-sync').hidden,false);
	assert.equal(f.dom.window.document.querySelector('#connect-form').closest('.settings-page').id,'settings-sync');
 }finally{f.dom.window.close();}
});

test('Windows hides macOS-only settings actions',async()=>{
 const f=await Fixture.create();try{
	await f.panel.open({settings:true,theme:{os:'windows'},config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},accessibility:false,input_monitoring:false});
	assert.equal(f.dom.window.getComputedStyle(f.dom.window.document.querySelector('#tui-card').parentElement).display,'none');
	await f.panel.open({settings:true,theme:{os:'macos'},config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},accessibility:false,input_monitoring:false});
	assert.equal(f.dom.window.getComputedStyle(f.dom.window.document.querySelector('#tui-card').parentElement).display,'block');
 }finally{f.dom.window.close();}
});

test('returning from macOS settings identifies the remaining missing permission',async()=>{
 const f=await Fixture.create();try{
	await f.panel.open({settings:true,theme:{os:'macos'},config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},accessibility:false,input_monitoring:false,status:'TypeRelay needs Input Monitoring, then Accessibility. Open Settings to allow both.'});
	f.panel.invoke=async(name)=>name==='initialize'?{config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},theme:{os:'macos'},settings:true,accessibility:true,input_monitoring:false,status:'TypeRelay needs Input Monitoring. Open Settings to allow it.'}:null;
	f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await new Promise(resolve=>setTimeout(resolve,0));
	assert.equal(f.dom.window.document.querySelector('#accessibility-card').hidden,false);
	assert.equal(f.dom.window.document.querySelector('#accessibility-state').textContent,'Approved');
	assert.equal(f.dom.window.document.querySelector('#open-accessibility').hidden,true);
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-card').hidden,false);
	assert.match(f.panel.status.textContent,/needs Input Monitoring/);
	f.panel.invoke=async(name)=>name==='initialize'?{config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},theme:{os:'macos'},settings:true,accessibility:true,input_monitoring:true,status:''}:null;
	f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await new Promise(resolve=>setTimeout(resolve,0));
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-card').hidden,false);
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-state').textContent,'Approved');
	assert.equal(f.dom.window.document.querySelector('#open-input-monitoring').hidden,true);
	assert.equal(f.panel.status.textContent,'');
 }finally{f.dom.window.close();}
});

test('returning from macOS Privacy settings refreshes permissions without a relaunch',async()=>{
 const f=await Fixture.create();try{
	await f.panel.open({settings:false,theme:{os:'macos'},config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},accessibility:false,input_monitoring:false,status:'TypeRelay needs Input Monitoring, then Accessibility. Open Settings to allow both.'});
	f.panel.invoke=async(name)=>name==='initialize'?{config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},theme:{os:'macos'},settings:false,accessibility:true,input_monitoring:true,status:''}:null;
	f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await new Promise(resolve=>setTimeout(resolve,0));
	assert.equal(f.dom.window.document.body.dataset.view,'search');
	assert.equal(f.dom.window.document.querySelector('#accessibility-card').hidden,false);
	assert.equal(f.dom.window.document.querySelector('#accessibility-state').textContent,'Approved');
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-card').hidden,false);
	assert.equal(f.dom.window.document.querySelector('#input-monitoring-state').textContent,'Approved');
	assert.equal(f.panel.status.textContent,'');
 }finally{f.dom.window.close();}
});

test('template fields wait for confirmation, retain literal answers and clear on cancellation',async()=>{
 const f=await Fixture.create();try{
  const original=f.panel.invoke;
  f.panel.invoke=async(name,args={})=>name==='prepare_template'?{fields:['name'],enter_actions:1,template:{text:'Hi {{name}}{{key:enter}}',variables:{name:{label:'Name',default:'',required:true,multiline:false}}},steps:[{kind:'text',text:'Hi '+(args.values?.name||'[Name]')},{kind:'enter'}]}:original(name,args);
  await f.panel.start(Fixture.hit('template'),'insert');
  assert.ok(!f.calls.some(call=>call.name==='insert'));
  const input=f.dom.window.document.querySelector('[data-answer]');input.value='{{key:enter}}';
  await f.panel.previewFill();assert.ok(f.dom.window.document.querySelector('#fill-preview').textContent.includes('{{key:enter}}'));
  await f.panel.commit();assert.equal(f.calls.find(call=>call.name==='insert').args.values.name,'{{key:enter}}');
  await f.panel.start(Fixture.hit('template'),'insert');f.panel.cancel();assert.equal(f.dom.window.document.querySelectorAll('[data-answer]').length,0);
 }finally{f.dom.window.close();}
});

test('manual sync relies on notifications without adding panel status',async()=>{
 const f=await Fixture.create();try{
  f.panel.status.textContent='';
  await f.dom.window.document.querySelector('#sync').onclick();
  assert.ok(f.calls.some(call=>call.name==='sync_now'));
  assert.equal(f.panel.status.textContent,'');
  assert.ok(!f.calls.some(call=>call.name==='dismiss'));
 }finally{f.dom.window.close();}
});

for(const os of ['macos','windows','linux'])test(`${os} native sync events update only the initiating button`,async()=>{
 const f=await Fixture.create();try{
  f.dom.window.document.body.dataset.os=os;
  const button=f.dom.window.document.querySelector('#sync');
  const server=f.dom.window.document.querySelector('#server');server.value='https://example.test';server.focus();
  const before=f.calls.length;
  f.callbacks['sync-notice']({payload:{message:'Starting to sync…',running:true,visible:true}});
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Syncing…');
  for(const [message,icon] of [['Sync successful','success'],['Sync completed — some changes need attention.','warning'],['Sync failed. Check your connection.','error']]){
   f.callbacks['sync-notice']({payload:{message,running:false,visible:true}});
   assert.equal(button.disabled,false);assert.equal(button.textContent,'Sync now');
  }
  assert.ok(f.calls.slice(before).every(call=>call.name==='libraries'));assert.equal(server.value,'https://example.test');assert.equal(f.dom.window.document.activeElement,server);
  f.callbacks['sync-notice']({payload:{message:'Sync successful',running:false,visible:false}});
 }finally{f.dom.window.close();}
});

test('Sync settings retain synced libraries and reconcile only changed rows after sync',async()=>{
 const f=await Fixture.create();try{
  let rows=[{id:'remote',name:'mysnippets.yml',synced:true,snippets:67},{id:'local',name:'test',synced:false,snippets:2}];
  const original=f.panel.invoke;f.panel.invoke=async(name,args)=>name==='libraries'?structuredClone(rows):original(name,args);
  await f.panel.refreshLibraries();
  const container=f.dom.window.document.querySelector('#local-libraries');const remote=container.children[0];const local=container.children[1];
  assert.equal(remote.querySelector('.library-name').textContent,'mysnippets.yml (67)');assert.equal(remote.querySelector('.library-sync-state').textContent,'Synced');assert.equal(remote.querySelector('input').disabled,true);
  const checkbox=local.querySelector('input');checkbox.checked=true;checkbox.focus();
  const before=f.calls.length;rows[0].snippets=68;
  await f.callbacks['sync-notice']({payload:{running:false}});
  assert.equal(container.children[0],remote);assert.equal(container.children[1],local);assert.equal(remote.querySelector('.library-name').textContent,'mysnippets.yml (68)');assert.equal(checkbox.checked,true);assert.equal(f.dom.window.document.activeElement,checkbox);assert.equal(f.calls.length,before);
  rows[1].synced=true;await f.panel.refreshLibraries();assert.equal(checkbox.checked,false);assert.equal(checkbox.disabled,true);assert.equal(local.querySelector('.library-sync-state').textContent,'Synced');
  const pending=[];f.panel.invoke=async()=>new Promise(resolve=>pending.push(resolve));
  const stale=f.panel.refreshLibraries();const fresh=f.panel.refreshLibraries();pending[1]([rows[1]]);await fresh;pending[0](rows);await stale;
  assert.equal(container.children.length,1);assert.equal(container.children[0],local);
 }finally{f.dom.window.close();}
});

for(const os of ['macos','windows','linux'])test(`${os} search gear opens native settings focus mode`,async()=>{
 const f=await Fixture.create();try{
  f.dom.window.document.body.dataset.os=os;await f.panel.settings(false);
  const button=f.dom.window.document.querySelector('#open-settings');assert.notEqual(f.dom.window.getComputedStyle(button).display,'none');assert.equal(button.getAttribute('aria-label'),'Open settings');
  button.click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.dom.window.document.querySelector('#settings-view').hidden,false);assert.equal(f.dom.window.document.querySelector('#search-view').hidden,true);assert.equal(f.calls.filter(call=>call.name==='set_settings_view').at(-1).args.enabled,true);
  assert.equal(f.dom.window.getComputedStyle(button).display,'none');
  await f.panel.settings(false);assert.notEqual(f.dom.window.getComputedStyle(button).display,'none');
 }finally{f.dom.window.close();}
});

test('notification settings show permission and remain reachable when enabled',async()=>{
 const f=await Fixture.create();try{
  const config={shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false};
  const state=f.dom.window.document.querySelector('#notifications-state');
  const button=f.dom.window.document.querySelector('#open-notifications');
  f.panel.configure({config,notifications:false});assert.equal(state.textContent,'Disabled');assert.equal(button.hidden,false);
  button.click();await new Promise(resolve=>setTimeout(resolve,0));assert.ok(f.calls.some(call=>call.name==='open_notification_settings'));
  const invoke=f.panel.invoke;f.panel.invoke=async(name,args)=>name==='initialize'?{config,notifications:true,status:''}:invoke(name,args);
  await f.panel.refreshPermissions();assert.equal(state.textContent,'Enabled');assert.equal(button.hidden,false);
  f.panel.configure({config,notifications:null});assert.equal(state.textContent,'Unavailable');
 }finally{f.dom.window.close();}
});

test('connected clients can disconnect without dismissing the panel',async()=>{
 const f=await Fixture.create();try{
  f.panel.configure({config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},connected:true,accessibility:false,input_monitoring:false});
  const button=f.dom.window.document.querySelector('#disconnect');assert.equal(button.hidden,false);assert.equal(button.disabled,false);
  button.click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(f.calls.some(call=>call.name==='disconnect'));
  assert.equal(f.panel.status.textContent,'Disconnected');
  assert.ok(!f.calls.some(call=>call.name==='dismiss'));
  f.panel.configure({config:{shortcut:'Ctrl+Shift+Semicolon',launch_at_login:false},connected:false,accessibility:false,input_monitoring:false});assert.equal(button.hidden,false);assert.equal(button.disabled,false);
 }finally{f.dom.window.close();}
});

test('authentication handoff does not reopen settings over the browser',async()=>{
 const f=await Fixture.create();try{
  const before=f.calls.filter(call=>call.name==='set_settings_view').length;
  f.dom.window.document.querySelector('#connect-form').requestSubmit();await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(f.calls.some(call=>call.name==='connect'));
  assert.equal(f.calls.filter(call=>call.name==='set_settings_view').length,before);
  assert.equal(f.panel.status.textContent,'Connected');
 }finally{f.dom.window.close();}
});

test('search loupe is right aligned and title bar has no shortcut badge',async()=>{
 const f=await Fixture.create();try{
  const style=f.dom.window.getComputedStyle(f.dom.window.document.querySelector('.search-icon'));
  assert.equal(style.right,'0.85rem');assert.equal(style.left,'auto');
  assert.equal(f.dom.window.document.querySelector('.shortcut-key'),null);
 }finally{f.dom.window.close();}
});
