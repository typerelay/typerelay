export class Suggestions {
	constructor(panel) {
		this.panel=panel;this.rows=new Map();this.revisions=new Map();this.epoch=0;this.sequence=0;this.loaded=false;this.draft=null;this.changeSequence=0;this.updated=new Map();
		this.editSequence=0;this.reviewScroll=0;this.checkSequence=0;this.form=document.querySelector('#observation-form');this.list=document.querySelector('#suggestions-list');
		document.querySelector('#observation-check').onclick=event=>this.run(event.currentTarget,()=>this.check());
		document.querySelector('#observation-test-notification').onclick=event=>this.run(event.currentTarget,async()=>{await this.invoke('test-notification');document.querySelector('#observation-notification-result').textContent='Test sent. If no notification appeared, allow Typerelay notifications in your system settings and check Do Not Disturb or Focus mode.';});
		document.querySelector('#suggestions-review').onclick=event=>this.run(event.currentTarget,()=>this.open());
		this.form.onsubmit=event=>{event.preventDefault();void this.run(document.querySelector('#observation-save'),()=>this.configure());};
		document.querySelector('#observation-enabled').onchange=()=>{if(!document.querySelector('#observation-enabled').checked&&this.settings?.enabled)void this.run(document.querySelector('#observation-enabled'),()=>this.configure({...this.settings,enabled:false}));};
		document.querySelector('#observation-forget').onclick=event=>this.run(event.currentTarget,()=>this.forget());
		document.querySelector('#suggestion-editor').onsubmit=event=>{event.preventDefault();void this.run(document.querySelector('#suggestion-save'),()=>this.save());};
		document.querySelector('#suggestion-cancel').onclick=()=>this.cancel();
		window.__TAURI__.event.listen('observation-status',event=>document.querySelector('#observation-status').textContent=event.payload);
		window.__TAURI__.event.listen('suggestion-change',event=>this.change(event.payload));
		window.__TAURI__.event.listen('suggestions-forgotten',event=>this.forgotten(event.payload.epoch));
	}
	invoke(action,value){return this.panel.invoke('suggestions',{action,value});}
	async run(button,operation){if(button.disabled)return;button.disabled=true;try{await operation();}catch(error){await Swal.fire({icon:'error',title:'Snippet suggestions',text:String(error),confirmButtonText:'OK'});}finally{button.disabled=false;}}
	async open(sequence=this.panel.openSequence=(this.panel.openSequence||0)+1){this.panel.cancelAi();await this.panel.invoke('set_settings_view',{enabled:true,suggestions:true});if(sequence!==this.panel.openSequence)return;document.body.dataset.view='suggestions';document.querySelector('#window-title').textContent='Suggestions';for(const id of ['search-view','settings-view','fill-view'])document.querySelector('#'+id).hidden=true;document.querySelector('#suggestions-view').hidden=false;await this.load();if(!this.draft&&!document.querySelector('#suggestions-view').hidden)document.querySelector('#suggestion-heading').focus({preventScroll:true});}
	async load(){
		const sequence=++this.sequence;const checkSequence=this.checkSequence;const started=this.changeSequence;const startEpoch=this.epoch;const snapshot=await this.invoke('list');if(sequence!==this.sequence||snapshot.epoch<this.epoch||startEpoch!==this.epoch&&snapshot.epoch!==this.epoch)return;
		document.querySelector('#suggestion-prefix').textContent=snapshot.prefix||'';this.epoch=snapshot.epoch;this.settings=snapshot.settings;this.loaded=true;if(snapshot.setup&&checkSequence===this.checkSequence)this.setup(snapshot.setup);
		document.querySelector('#observation-enabled').checked=this.settings.enabled;document.querySelector('#observation-notifications').checked=this.settings.notifications;document.querySelector('#observation-threshold').value=this.settings.threshold;document.querySelector('#observation-retention').value=this.settings.retention_days;document.querySelector('#observation-exclusions').value=this.settings.excluded_apps.join('\n');document.querySelector('#observation-status').textContent=snapshot.status;
		const changes=snapshot.changes||snapshot.candidates.map(candidate=>({id:candidate.id,revision:candidate.revision,candidate}));const present=new Set(changes.map(row=>row.id));for(const [id,row]of this.rows)if(!present.has(id)&&(this.updated.get(id)||0)<=started)this.change({epoch:this.epoch,change:{id,revision:row.revision+1,candidate:null}});
		for(const change of changes)this.change({epoch:this.epoch,change});this.empty();
	}
	async check(){const sequence=++this.checkSequence;const result=await this.invoke('check');if(sequence===this.checkSequence)this.setup(result);}
	setup(value){
		if(value.epoch!==undefined&&value.epoch<this.epoch)return;
		const checks=[{id:'enabled',label:'Observation',detail:value.enabled?'Enabled on this device.':'Enable Observe repeated text above and save settings.'}];
		if(value.platform==='macos')for(const [key,label,action]of [['accessibility','Accessibility','open_accessibility_settings'],['input_monitoring','Input Monitoring','open_input_monitoring_settings']])checks.push({id:key,label,detail:value[key]?'Allowed.':'Allow Typerelay in System Settings, then restart Typerelay.',action:value[key]?null:action,button:'Open '+label+' settings'});
		checks.push({id:'typing',label:'Typing check',detail:value.observed_app?'Typing received from '+(value.observed_app==='code'?'VS Code':value.observed_app)+' in the last minute.':value.enabled?'No typing verified in the last minute. Type in another app, then click Check setup.':'Enable observation before testing typing.'});
		checks.push({id:'status',label:'Observer status',detail:value.status});
		if(value.vscode)checks.push({id:'vscode',label:'VS Code',detail:value.vscode==='off'?'Accessibility is switched off. In VS Code Settings, set Editor: Accessibility Support to On.':value.vscode==='on'?'Accessibility is enabled in user settings. Run the typing check to verify the current editor.':'In VS Code Settings, set Editor: Accessibility Support to On if the typing check does not pass.'});
		checks.push({id:'notifications',label:'Suggestion notifications',detail:!value.notifications_enabled?'Enable Show suggestion notifications above and save settings.':value.notifications_allowed===false?'Allow Typerelay notifications in System Settings.':'Enabled in Typerelay. Send a test notification to check system delivery.',action:value.platform==='macos'&&value.notifications_allowed===false?'open_notification_settings':null,button:'Open notification settings'});
		const list=document.querySelector('#observation-checks');const nodes=new Map([...list.children].map(node=>[node.dataset.id,node]));
		for(const check of checks){let node=nodes.get(check.id);nodes.delete(check.id);if(!node){node=document.querySelector('#observation-check-template').content.firstElementChild.cloneNode(true);node.dataset.id=check.id;list.append(node);}node.querySelector('.observation-check-label').textContent=check.label;node.querySelector('.observation-check-detail').textContent=check.detail;const button=node.querySelector('button');button.hidden=!check.action;button.textContent=check.button||'';button.onclick=event=>this.run(event.currentTarget,()=>this.panel.invoke(check.action));}for(const node of nodes.values())node.remove();
		if(value.vscode==='off')document.querySelector('#observation-app-help').open=true;
		document.querySelector('#observation-platform-help').textContent=value.platform==='macos'?'macOS: allow Accessibility and Input Monitoring for Typerelay, then restart it.':value.platform==='windows'?'Windows: run the editor as your normal user. Administrator windows and protected controls may block observation.':'Linux: enable accessibility in your desktop and editor. If the observer reports missing accessibility components, install AT-SPI 2 and restart Typerelay.';
	}
	async configure(value){
		const settings=value||{enabled:document.querySelector('#observation-enabled').checked,notifications:document.querySelector('#observation-notifications').checked,threshold:Number(document.querySelector('#observation-threshold').value),retention_days:Number(document.querySelector('#observation-retention').value),excluded_apps:[...new Set(document.querySelector('#observation-exclusions').value.split('\n').map(value=>value.trim()).filter(Boolean))]};
		const result=await this.invoke('configure',settings);if(result.epoch<this.epoch)return;this.epoch=result.epoch;for(const change of result.changes||[])this.change({epoch:result.epoch,change});this.settings=settings;await this.check();document.querySelector('#observation-status').textContent=settings.enabled?'Waiting for a supported editable field':'Disabled';await Swal.fire({toast:true,position:'bottom-end',icon:'success',title:'Settings saved',showConfirmButton:false,timer:2000});
	}
	change(envelope){
		if(envelope.epoch<this.epoch)return;this.epoch=envelope.epoch;const {id,revision,candidate}=envelope.change;if(revision<=(this.revisions.get(id)||0))return;this.revisions.set(id,revision);this.updated.set(id,++this.changeSequence);
		let node=[...this.list.children].find(node=>node.dataset.id===id);
		if(!candidate){this.rows.delete(id);node?.remove();this.empty();return;}
		this.rows.set(id,candidate);if(!node){node=document.querySelector('#suggestion-template').content.firstElementChild.cloneNode(true);node.dataset.id=id;this.list.append(node);}
		node.querySelector('.suggestion-text').textContent=candidate.text;
		node.querySelector('.suggestion-create').onclick=event=>this.run(event.currentTarget,()=>this.edit(id));
		for(const action of ['delete','ignore'])node.querySelector('.suggestion-'+action).onclick=event=>this.run(event.currentTarget,async()=>{const row=this.rows.get(id);if(row)this.change(await this.invoke(action,{id,revision:row.revision}));});this.empty();
	}
	empty(){document.querySelector('#suggestions-empty').hidden=this.rows.size>0;}
	async edit(id){
		if(this.draft&&this.draft.id!==id){const answer=await Swal.fire({title:'Replace this draft?',text:'Your unsaved edits will be discarded.',showCancelButton:true,confirmButtonText:'Replace',reverseButtons:true});if(!answer.isConfirmed)return;}
		const row=this.rows.get(id);if(!row)return;const sequence=++this.editSequence;const epoch=this.epoch;const libraries=await this.invoke('libraries');if(sequence!==this.editSequence||epoch!==this.epoch||!this.rows.has(id))return;if(!libraries.length)throw Error('Create a writable library in Typerelay first. Your suggestion is kept.');
		this.draft={...row};document.querySelector('#suggestion-title').value='';document.querySelector('#suggestion-abbreviation').value='';document.querySelector('#suggestion-text').value=row.text;
		const select=document.querySelector('#suggestion-library');for(const option of [...select.options].slice(1))option.remove();for(const library of libraries){const option=document.querySelector('#suggestion-library-option').content.firstElementChild.cloneNode(true);option.value=library.id;option.textContent=library.name+' · '+(library.shared?'Shared':library.synced?'Synced':'Local only');select.append(option);}select.value='';
		this.reviewScroll=document.querySelector('#suggestions-view').scrollTop;document.querySelector('#suggestion-review').hidden=true;document.querySelector('#suggestion-editor').hidden=false;document.querySelector('#suggestions-view').scrollTop=0;document.querySelector('#suggestion-abbreviation').focus({preventScroll:true});
	}
	cancel(){this.editSequence++;const id=this.draft?.id;this.draft=null;document.querySelector('#suggestion-editor').hidden=true;document.querySelector('#suggestion-review').hidden=false;document.querySelector('#suggestion-text').value='';const node=[...this.list.children].find(node=>node.dataset.id===id);(node?.querySelector('.suggestion-create')||document.querySelector('#suggestion-heading')).focus({preventScroll:true});document.querySelector('#suggestions-view').scrollTop=this.reviewScroll;}
	async save(){
		if(!this.draft)return;const draft={replace:document.querySelector('#suggestion-text').value,title:document.querySelector('#suggestion-title').value,trigger:document.querySelector('#suggestion-abbreviation').value,type:'plain_text',language:'plain_text',variables:{}};
		const result=await this.invoke('save',{id:this.draft.id,revision:this.rows.get(this.draft.id)?.revision??this.draft.revision,library:document.querySelector('#suggestion-library').value,draft});this.change(result);this.cancel();await Swal.fire({toast:true,position:'bottom-end',icon:'success',title:'Snippet saved',showConfirmButton:false,timer:2000});
	}
	forgotten(epoch){if(epoch<this.epoch)return;this.epoch=epoch;this.sequence++;for(const node of [...this.list.children])node.remove();this.rows.clear();this.revisions.clear();this.updated.clear();this.cancel();this.empty();}
	async forget(){const answer=await Swal.fire({title:'Forget learned text?',text:'Delete observed candidates, counts, and ignored phrases on this device. Saved snippets are kept. Observation continues if enabled.',showCancelButton:true,confirmButtonText:'Forget',reverseButtons:true});if(!answer.isConfirmed)return;const result=await this.invoke('forget');this.forgotten(result.epoch);}
}
