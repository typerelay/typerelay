import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
 static async create() {
  const dom=new JSDOM(pug.renderFile('ui/index.pug'),{runScripts:'outside-only',pretendToBeVisual:true});
  const calls=[];const callbacks={};const pending=[];
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  dom.window.__TAURI__={core:{invoke:async(name,args)=>{calls.push({name,args});if(name==='initialize')return{config:{shortcut:'Ctrl+Shift+Comma',launch_at_login:false},theme:{os:'linux'},settings:false};if(name==='search')return new Promise(resolve=>pending.push({query:args.query,resolve}));if(name==='libraries')return[];return null;}},event:{listen:(name,callback)=>{callbacks[name]=callback;}}};
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
