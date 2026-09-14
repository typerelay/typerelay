class Panel {
	constructor() {
		this.fillSequence=0; this.filling=null; this.rows=[]; this.index=0; this.sequence=0; this.busy=false;
		this.invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args);
		this.query=document.querySelector('#query');
		this.list=document.querySelector('#results');
		this.status=document.querySelector('#status');
		this.query.addEventListener('input',()=>{clearTimeout(this.timer);const sequence=++this.sequence;this.rows=[];this.render();this.timer=setTimeout(()=>this.search(sequence),60);});
		document.addEventListener('keydown',event=>{
			if(event.key==='Escape'){event.preventDefault();this.cancel();return;}
			if(this.filling){if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();document.querySelector('#fill-form').requestSubmit();}return;}
			if(!document.querySelector('#settings-view').hidden)return;
			if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();this.select(this.index+(event.key==='ArrowDown'?1:-1));}
			if(event.key==='Enter'){event.preventDefault();this.insert();}
		});
		document.querySelector('#copy').onclick=()=>this.action(()=>this.start(this.rows[this.index],'copy'));
		document.querySelector('#close').onclick=()=>this.cancel();
		document.querySelector('#fill-cancel').onclick=()=>this.cancel();
		document.querySelector('#fill-copy').onclick=()=>this.action(async()=>{const mode=this.fillMode;this.fillMode='copy';try{await this.commit();}finally{if(this.filling)this.fillMode=mode;}});
		document.querySelector('#fill-form').onsubmit=event=>{event.preventDefault();this.action(()=>this.commit());};
		document.querySelector('#fill-fields').oninput=()=>{clearTimeout(this.fillTimer);this.fillTimer=setTimeout(()=>this.previewFill(),80);};
		document.querySelector('#settings-cancel').onclick=()=>this.settings(false);
		document.querySelector('#settings-form').onsubmit=event=>{event.preventDefault();this.action(async()=>{await this.invoke('save_settings',{config:{shortcut:document.querySelector('#shortcut').value,launch_at_login:document.querySelector('#autostart').checked}});this.status.textContent='Settings saved';});};
		document.querySelector('#connect-form').onsubmit=event=>{event.preventDefault();this.action(async()=>{this.status.textContent='Complete sign-in in your browser…';await this.invoke('connect',{url:document.querySelector('#server').value});this.status.textContent='Connected';await this.settings(true);});};
		document.querySelector('#sync').onclick=()=>this.action(async()=>{await this.invoke('sync_now');this.status.textContent='Sync requested';});
		document.querySelector('#enroll-form').onsubmit=event=>{event.preventDefault();this.action(async()=>{const names=[...document.querySelectorAll('#local-libraries input:checked')].map(input=>input.value);if(!names.length)throw Error('Select local libraries first');await this.invoke('enroll',{names});await this.settings(true);this.status.textContent='Upload queued';});};
		window.__TAURI__.event.listen('panel-error',event=>this.status.textContent=String(event.payload));
		window.__TAURI__.event.listen('panel-open',event=>this.open(event.payload));
		this.invoke('initialize').then(value=>{this.configure(value);this.open(value);}).catch(error=>this.status.textContent=String(error));
	}
	configure(value){document.querySelector('#shortcut').value=value.config.shortcut;document.querySelector('#autostart').checked=value.config.launch_at_login;if(value.server)document.querySelector('#server').value=value.server;}
	async open(value){this.filling=null;document.querySelector('#fill-view').hidden=true;document.querySelector('#fill-fields').replaceChildren();this.sequence++;this.query.value='';this.rows=[];this.render();this.status.textContent=value.status||'';document.body.dataset.os=value.theme?.os||'';for(const key of ['background','foreground','accent']){if(/^#[0-9a-f]{6}$/i.test(value.theme?.[key]||''))document.body.style.setProperty('--'+key,value.theme[key]);}await this.settings(!!value.settings);if(value.prompt)await this.action(()=>this.start(value.prompt,'insert'));}
	async settings(visible){await this.invoke('set_settings_view',{enabled:visible});document.querySelector('#settings-view').hidden=!visible;document.querySelector('#search-view').hidden=visible;if(visible){try{const value=await this.invoke('initialize');this.configure(value);const libraries=await this.invoke('libraries');const container=document.querySelector('#local-libraries');container.replaceChildren();for(const library of libraries){const node=document.querySelector('#library-template').content.firstElementChild.cloneNode(true);node.querySelector('input').value=library.name;node.querySelector('span').textContent=library.name;container.append(node);}}catch(error){this.status.textContent=String(error);}}else{this.query.focus();}}
	async search(sequence){try{const rows=await this.invoke('search',{query:this.query.value});if(sequence!==this.sequence)return;this.rows=rows;this.index=0;this.render();}catch(error){if(sequence===this.sequence)this.status.textContent=String(error);}}
	render(){this.list.replaceChildren();document.querySelector('#hint').hidden=!!this.rows.length;document.querySelector('#hint').textContent=this.query.value?'No matching snippets.':'Type an abbreviation or part of a snippet.';for(const [index,row] of this.rows.entries()){const node=document.querySelector('#result-template').content.firstElementChild.cloneNode(true);node.querySelector('.result-title').textContent=row.title||row.abbreviation||'Untitled snippet';node.querySelector('.result-library').textContent=row.library_name;node.querySelector('.result-abbreviation').textContent=row.abbreviation;node.querySelector('.result-preview').textContent=row.preview;node.onclick=()=>this.select(index);node.ondblclick=()=>{this.select(index);this.insert();};this.list.append(node);}this.select(0);}
	select(index){this.index=Math.max(0,Math.min(index,this.rows.length-1));[...this.list.children].forEach((node,i)=>{node.setAttribute('aria-selected',String(i===this.index));if(i===this.index)node.scrollIntoView({block:'nearest'});});document.querySelector('#copy').disabled=!this.rows.length;}
	async action(action){if(this.busy)return;this.busy=true;try{await action();}catch(error){this.status.textContent=String(error);}finally{this.busy=false;}}
	insert(){this.action(async()=>{const sequence=this.sequence;if(!this.rows.length&&this.query.value){clearTimeout(this.timer);await this.search(sequence);}if(sequence===this.sequence&&this.rows.length)await this.start(this.rows[this.index],'insert');});}
	cancel(){this.filling=null;document.querySelector('#fill-fields').replaceChildren();document.querySelector('#fill-preview').textContent='';this.invoke('dismiss');}
	answers(){return Object.fromEntries([...document.querySelectorAll('[data-answer]')].map(field=>[field.dataset.answer,field.value]));}
	async start(hit,mode){
		if(!hit)return;
		const result=await this.invoke('prepare_template',{hit});
		this.filling=hit;this.fillMode=mode;this.enterActions=result.enter_actions;
		if(!result.fields.length){await this.commit();return;}
		await this.invoke('set_prompt_view',{enabled:true});
		document.querySelector('#search-view').hidden=true;document.querySelector('#settings-view').hidden=true;document.querySelector('#fill-view').hidden=false;
		const container=document.querySelector('#fill-fields');container.replaceChildren();
		for(const name of result.fields){const field=result.template.variables[name];const row=document.querySelector('#fill-field').content.firstElementChild.cloneNode(true);const input=row.querySelector(field.multiline?'textarea':'input');row.querySelector('input').hidden=field.multiline;row.querySelector('textarea').hidden=!field.multiline;input.id='fill-'+name;input.dataset.answer=name;input.value=field.default;input.required=field.required;row.querySelector('label').htmlFor=input.id;row.querySelector('label').textContent=field.label+(field.required?' *':'');container.append(row);}
		document.querySelector('#fill-submit').textContent=mode==='copy'?'Copy filled text':'Insert';document.querySelector('#fill-copy').hidden=mode==='copy';
		document.querySelector('#fill-actions').textContent=result.enter_actions?(mode==='copy'?'Copy omits Enter key actions.':'Includes '+result.enter_actions+' Enter keypress(es).'):'';
		await this.previewFill();container.querySelector('[data-answer]')?.focus();
	}
	async previewFill(){const hit=this.filling;if(!hit)return;const sequence=++this.fillSequence;try{const result=await this.invoke('prepare_template',{hit,values:this.answers()});if(this.filling!==hit||sequence!==this.fillSequence)return;document.querySelector('#fill-preview').textContent=result.steps.map(step=>step.kind==='enter'?'⏎ [Enter key]':step.text).join('');this.status.textContent='';}catch(error){this.status.textContent=String(error);}}
	async commit(){const hit=this.filling;if(!hit)return;const values=this.answers();await this.invoke(this.fillMode==='copy'?'copy_snippet':'insert',{hit,values});const copied=this.fillMode==='copy';this.filling=null;document.querySelector('#fill-fields').replaceChildren();document.querySelector('#fill-view').hidden=true;await this.invoke('set_prompt_view',{enabled:false});if(copied){document.querySelector('#search-view').hidden=false;this.status.textContent=this.enterActions?'Copied text; Enter key actions omitted.':'Copied';}}

}
new Panel();
