import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import pug from 'pug';

class Fixture {
	static async create() {
		const dom=new JSDOM(pug.renderFile('ui/index.pug'),{runScripts:'outside-only',pretendToBeVisual:true});const calls=[];const events={};
		dom.window.Swal={fire:async()=>({isConfirmed:true})};dom.window.__TAURI__={event:{listen:(name,callback)=>events[name]=callback}};
		dom.window.eval((await readFile('ui/suggestions.js','utf8')).replace('export class Suggestions','window.Suggestions=class Suggestions'));
		const panel={cancelAi:()=>{},invoke:async(name,args)=>{calls.push({name,args});throw Error('Unexpected command');},settings:()=>{throw Error('No section reload allowed');},settingsPage:()=>{throw Error('No section reload allowed');}};
		return {dom,calls,events,panel,ui:new dom.window.Suggestions(panel)};
	}
	static row(id='one',revision=5){return{id,revision,text:'A useful repeated sentence.',count:4};}
	static change(row){return{epoch:1,change:{id:row.id,revision:row.revision,candidate:row}};}
}

test('suggestion updates preserve node, draft, focus and scroll; stale events cannot resurrect deletions',async()=>{
	const f=await Fixture.create();try{
		f.ui.change(Fixture.change(Fixture.row()));const node=f.ui.list.firstElementChild;const button=node.querySelector('.suggestion-create');button.focus();f.ui.list.scrollTop=37;
		f.ui.change(Fixture.change({...Fixture.row('one',6),count:5}));assert.equal(f.ui.list.firstElementChild,node);assert.equal(f.dom.window.document.activeElement,button);assert.equal(f.ui.list.scrollTop,37);
		f.ui.change({epoch:1,change:{id:'one',revision:7,candidate:null}});f.ui.change(Fixture.change(Fixture.row('one',6)));assert.equal(f.ui.list.children.length,0);assert.equal(f.calls.length,0);
	}finally{f.dom.window.close();}
});

test('save uses the selected library, updates one item, preserves failed drafts and prevents duplicate clicks',async()=>{
	const f=await Fixture.create();try{
		f.ui.change(Fixture.change(Fixture.row()));f.ui.change(Fixture.change(Fixture.row('two')));const sibling=f.ui.list.children[1];
		f.panel.invoke=async(name,args)=>{f.calls.push({name,args});if(args.action==='libraries')return[{id:'shared',name:'Team',synced:true,shared:true}];if(args.action==='save')throw Error('Connection unavailable');throw Error('Unexpected loader');};await f.ui.edit('one');
		const document=f.dom.window.document;document.querySelector('#suggestion-library').value='shared';document.querySelector('#suggestion-text').value='Edited by the user.';
		await assert.rejects(()=>f.ui.save());assert.equal(document.querySelector('#suggestion-text').value,'Edited by the user.');assert.equal(document.querySelector('#suggestion-editor').hidden,false);
		let resolve;f.panel.invoke=async(name,args)=>{f.calls.push({name,args});return new Promise(done=>resolve=done);};const save=document.querySelector('#suggestion-save');const first=f.ui.run(save,()=>f.ui.save());await f.ui.run(save,()=>f.ui.save());resolve({epoch:1,change:{id:'one',revision:6,candidate:null}});await first;
		assert.equal(f.ui.list.firstElementChild,sibling);assert.equal(document.querySelector('#suggestion-review').hidden,false);assert.equal(document.querySelector('#suggestion-editor').hidden,true);assert.equal(f.ui.rows.has('one'),false);assert.equal(f.calls.filter(call=>call.args.action==='save').length,2);assert.equal(f.calls.at(-1).args.value.library,'shared');assert.equal(f.calls.at(-1).args.value.draft.replace,'Edited by the user.');
	}finally{f.dom.window.close();}
});

test('forget rejects queued events and outstanding list or editor responses',async()=>{
	const f=await Fixture.create();try{
		let resolve;f.panel.invoke=()=>new Promise(done=>resolve=done);const request=f.ui.load();f.ui.forgotten(2);resolve({epoch:1,settings:{},candidates:[Fixture.row()]});await request;
		f.ui.change(Fixture.change(Fixture.row()));assert.equal(f.ui.list.children.length,0);assert.equal(f.dom.window.document.querySelector('#suggestion-text').value,'');
	}finally{f.dom.window.close();}
});

test('an older initial snapshot cannot remove a newer event',async()=>{
	const f=await Fixture.create();try{
		let resolve;f.panel.invoke=()=>new Promise(done=>resolve=done);const request=f.ui.load();f.ui.change(Fixture.change(Fixture.row()));
		resolve({epoch:1,settings:{enabled:true,notifications:false,threshold:4,retention_days:30,excluded_apps:[]},status:'Active',candidates:[],changes:[]});await request;assert.equal(f.ui.list.children.length,1);
	}finally{f.dom.window.close();}
});


test('setup checks update in place, preserve drafts, and explain disabled VS Code accessibility',async()=>{
	const f=await Fixture.create();try{
		const document=f.dom.window.document;f.ui.change(Fixture.change(Fixture.row()));const candidate=f.ui.list.firstElementChild;document.querySelector('#suggestion-text').value='Keep my unfinished draft';
		const disabled={epoch:1,platform:'linux',enabled:true,notifications_enabled:true,status:'Waiting for a supported editable field',observed_app:null,vscode:'off'};
		f.ui.setup(disabled);const check=document.querySelector('[data-id="typing"]');const button=document.querySelector('#observation-check');button.focus();
		assert.match(document.querySelector('[data-id="vscode"]').textContent,/Accessibility is switched off/);assert.equal(document.querySelector('#observation-app-help').open,true);
		f.panel.invoke=async(name,args)=>{f.calls.push({name,args});assert.equal(args.action,'check');return {...disabled,observed_app:'code',vscode:'on'};};await f.ui.check();
		assert.equal(document.querySelector('[data-id="typing"]'),check);assert.match(check.textContent,/Typing received from VS Code/);assert.equal(document.activeElement,button);assert.equal(f.ui.list.firstElementChild,candidate);assert.equal(document.querySelector('#suggestion-text').value,'Keep my unfinished draft');
		f.ui.setup({...disabled,epoch:0});assert.match(check.textContent,/Typing received from VS Code/);
	}finally{f.dom.window.close();}
});

test('setup shows macOS permission actions and test notification uses only the notification command',async()=>{
	const f=await Fixture.create();try{
		const document=f.dom.window.document;f.ui.setup({platform:'macos',enabled:true,notifications_enabled:true,notifications_allowed:false,accessibility:false,input_monitoring:false,status:'Permission needed',observed_app:null});
		f.panel.invoke=async(name,args)=>{f.calls.push({name,args});return {};};await document.querySelector('[data-id="accessibility"] button').onclick({currentTarget:document.querySelector('[data-id="accessibility"] button')});
		assert.equal(f.calls[0].name,'open_accessibility_settings');await document.querySelector('#observation-test-notification').onclick({currentTarget:document.querySelector('#observation-test-notification')});
		assert.equal(f.calls[1].args.action,'test-notification');assert.match(document.querySelector('#observation-notification-result').textContent,/Test sent/);assert.equal(f.ui.rows.size,0);
	}finally{f.dom.window.close();}
});


test('dedicated suggestion list is replaced by the editor and cancel restores the same list',async()=>{
	const f=await Fixture.create();try{
		const document=f.dom.window.document;f.ui.change(Fixture.change(Fixture.row()));const card=f.ui.list.firstElementChild;
		assert.equal(card.querySelector('.suggestion-count'),null);assert.equal(card.querySelector('.suggestion-create').textContent,'Store as snippet');assert.equal(card.querySelector('.suggestion-ignore').textContent,'Never suggest again');assert.equal(card.querySelector('.suggestion-delete').textContent,'Delete');
		f.panel.invoke=async(name,args)=>{f.calls.push({name,args});if(args.action==='libraries')return[{id:'local',name:'Local'}];throw Error('No surrounding reload allowed');};
		await f.ui.edit('one');assert.equal(document.querySelector('#suggestion-review').hidden,true);assert.equal(document.querySelector('#suggestion-editor').hidden,false);assert.equal(document.activeElement.id,'suggestion-abbreviation');assert.equal(document.querySelector('#suggestion-title').required,false);assert.equal(document.querySelector('#suggestion-library').options.length,2);
		f.ui.cancel();assert.equal(document.querySelector('#suggestion-review').hidden,false);assert.equal(document.querySelector('#suggestion-editor').hidden,true);assert.equal(f.ui.list.firstElementChild,card);assert.equal(document.activeElement,card.querySelector('.suggestion-create'));
		let resolve;f.panel.invoke=()=>new Promise(done=>resolve=done);const pending=f.ui.edit('one');f.ui.cancel();resolve([{id:'local',name:'Local'}]);await pending;assert.equal(document.querySelector('#suggestion-editor').hidden,true);
	}finally{f.dom.window.close();}
});

test('delete and ignore remove only their own cards without reloading the list',async()=>{
	const f=await Fixture.create();try{
		f.ui.change(Fixture.change(Fixture.row()));f.ui.change(Fixture.change(Fixture.row('two')));const sibling=f.ui.list.children[1];
		f.panel.invoke=async(name,args)=>{f.calls.push({name,args});assert.equal(args.action,'delete');return {epoch:1,change:{id:'one',revision:6,candidate:null}};};const button=f.ui.list.firstElementChild.querySelector('.suggestion-delete');await button.onclick({currentTarget:button});
		assert.equal(f.ui.list.firstElementChild,sibling);assert.equal(f.calls.length,1);f.ui.change(Fixture.change(Fixture.row()));assert.equal(f.ui.list.children.length,1);
		f.panel.invoke=async(name,args)=>{assert.equal(args.action,'ignore');return {epoch:1,change:{id:'two',revision:6,candidate:null}};};const ignore=sibling.querySelector('.suggestion-ignore');await ignore.onclick({currentTarget:ignore});assert.equal(f.ui.list.children.length,0);
	}finally{f.dom.window.close();}
});

test('native setup preserves rows and does not request per-editor accessibility',async()=>{
	const f=await Fixture.create();try{
		const document=f.dom.window.document;f.ui.change(Fixture.change(Fixture.row()));const card=f.ui.list.firstElementChild;
		const value={epoch:1,platform:'linux',enabled:true,native_capture:true,notifications_enabled:true,vscode:'off',status:'Native capture ready',capture:{device:'Selected keyboard',desktop:'hyprland',layout:'English (US)',source:'keyboard'}};
		f.ui.setup(value);const row=document.querySelector('[data-id="capture-source"]');f.ui.setup({...value,capture:{...value.capture,blocked:'IME commit integration required'}});
		assert.equal(document.querySelector('[data-id="capture-source"]'),row);assert.match(row.textContent,/IME commit integration required/);assert.equal(document.querySelector('[data-id="vscode"]'),null);assert.equal(f.ui.list.firstElementChild,card);assert.equal(f.calls.length,0);
		const checkbox=document.querySelector('#observation-native');f.dom.window.Swal.fire=async()=>({isConfirmed:false});checkbox.checked=true;await checkbox.onchange({target:checkbox});assert.equal(checkbox.checked,false);
	}finally{f.dom.window.close();}
});
