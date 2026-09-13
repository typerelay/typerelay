class Panel {
	constructor() {
		this.rows=[]; this.index=0; this.sequence=0; this.busy=false;
		this.invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args);
		this.query=document.querySelector('#query');
		this.list=document.querySelector('#results');
		this.status=document.querySelector('#status');
		this.query.addEventListener('input',()=>{clearTimeout(this.timer);const sequence=++this.sequence;this.rows=[];this.render();this.timer=setTimeout(()=>this.search(sequence),60);});
		document.addEventListener('keydown',event=>{
			if(event.key==='Escape'){event.preventDefault();this.invoke('dismiss');return;}
			if(!document.querySelector('#settings-view').hidden)return;
			if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();this.select(this.index+(event.key==='ArrowDown'?1:-1));}
			if(event.key==='Enter'){event.preventDefault();this.insert();}
		});
		document.querySelector('#copy').onclick=()=>this.action(async()=>{await this.invoke('copy_snippet',{hit:this.rows[this.index]});this.status.textContent='Copied';});
		document.querySelector('#close').onclick=()=>this.invoke('dismiss');
		document.querySelector('#settings-toggle').onclick=()=>this.settings(true);
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
	async open(value){this.sequence++;this.query.value='';this.rows=[];this.render();this.status.textContent=value.status||'';document.body.dataset.os=value.theme?.os||'';for(const key of ['background','foreground','accent']){if(/^#[0-9a-f]{6}$/i.test(value.theme?.[key]||''))document.body.style.setProperty('--'+key,value.theme[key]);}await this.settings(!!value.settings);}
	async settings(visible){await this.invoke('set_settings_view',{enabled:visible});document.querySelector('#settings-view').hidden=!visible;document.querySelector('#search-view').hidden=visible;if(visible){try{const value=await this.invoke('initialize');this.configure(value);const libraries=await this.invoke('libraries');const container=document.querySelector('#local-libraries');container.replaceChildren();for(const library of libraries){const node=document.querySelector('#library-template').content.firstElementChild.cloneNode(true);node.querySelector('input').value=library.name;node.querySelector('span').textContent=library.name;container.append(node);}}catch(error){this.status.textContent=String(error);}}else{this.query.focus();}}
	async search(sequence){try{const rows=await this.invoke('search',{query:this.query.value});if(sequence!==this.sequence)return;this.rows=rows;this.index=0;this.render();}catch(error){if(sequence===this.sequence)this.status.textContent=String(error);}}
	render(){this.list.replaceChildren();document.querySelector('#hint').hidden=!!this.rows.length;document.querySelector('#hint').textContent=this.query.value?'No matching snippets.':'Type an abbreviation or part of a snippet.';for(const [index,row] of this.rows.entries()){const node=document.querySelector('#result-template').content.firstElementChild.cloneNode(true);node.querySelector('.result-title').textContent=row.title||row.abbreviation||'Untitled snippet';node.querySelector('.result-library').textContent=row.library_name;node.querySelector('.result-abbreviation').textContent=row.abbreviation;node.querySelector('.result-preview').textContent=row.preview;node.onclick=()=>this.select(index);node.ondblclick=()=>{this.select(index);this.insert();};this.list.append(node);}this.select(0);}
	select(index){this.index=Math.max(0,Math.min(index,this.rows.length-1));[...this.list.children].forEach((node,i)=>{node.setAttribute('aria-selected',String(i===this.index));if(i===this.index)node.scrollIntoView({block:'nearest'});});document.querySelector('#copy').disabled=!this.rows.length;}
	async action(action){if(this.busy)return;this.busy=true;try{await action();}catch(error){this.status.textContent=String(error);}finally{this.busy=false;}}
	insert(){this.action(async()=>{const sequence=this.sequence;if(!this.rows.length&&this.query.value){clearTimeout(this.timer);await this.search(sequence);}if(sequence===this.sequence&&this.rows.length)await this.invoke('insert',{hit:this.rows[this.index]});});}
}
new Panel();
