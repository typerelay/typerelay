export class Suggestions {
	constructor(panel) {
		this.panel=panel;this.rows=new Map();this.revisions=new Map();this.epoch=0;this.sequence=0;this.loaded=false;this.draft=null;this.changeSequence=0;this.updated=new Map();
		this.form=document.querySelector('#observation-form');this.list=document.querySelector('#suggestions-list');
		document.querySelector('#suggestions-review').onclick=()=>{document.querySelector('#suggestion-heading').focus();};
		this.form.onsubmit=event=>{event.preventDefault();void this.run(document.querySelector('#observation-save'),()=>this.configure());};
		document.querySelector('#observation-enabled').onchange=()=>{if(!document.querySelector('#observation-enabled').checked&&this.settings?.enabled)void this.run(document.querySelector('#observation-enabled'),()=>this.configure({...this.settings,enabled:false}));};
		document.querySelector('#observation-forget').onclick=event=>this.run(event.currentTarget,()=>this.forget());
		document.querySelector('#suggestion-editor').onsubmit=event=>{event.preventDefault();void this.run(document.querySelector('#suggestion-save'),()=>this.save());};
		document.querySelector('#suggestion-cancel').onclick=()=>this.cancel();
		window.__TAURI__.event.listen('observation-status',event=>document.querySelector('#observation-status').textContent=event.payload);
		window.__TAURI__.event.listen('suggestion-change',event=>this.change(event.payload));
		window.__TAURI__.event.listen('suggestions-forgotten',event=>this.forgotten(event.payload.epoch));
		window.__TAURI__.event.listen('suggestions-open',()=>this.open());
	}
	invoke(action,value){return this.panel.invoke('suggestions',{action,value});}
	async run(button,operation){if(button.disabled)return;button.disabled=true;try{await operation();}catch(error){await Swal.fire({icon:'error',title:'Snippet suggestions',text:String(error),confirmButtonText:'OK'});}finally{button.disabled=false;}}
	async open(){this.panel.settingsTab='suggestions';await this.panel.settings(true);}
	async load(){
		const sequence=++this.sequence;const started=this.changeSequence;const startEpoch=this.epoch;const snapshot=await this.invoke('list');if(sequence!==this.sequence||snapshot.epoch<this.epoch||startEpoch!==this.epoch&&snapshot.epoch!==this.epoch)return;
		this.epoch=snapshot.epoch;this.settings=snapshot.settings;this.loaded=true;
		document.querySelector('#observation-enabled').checked=this.settings.enabled;document.querySelector('#observation-notifications').checked=this.settings.notifications;document.querySelector('#observation-threshold').value=this.settings.threshold;document.querySelector('#observation-retention').value=this.settings.retention_days;document.querySelector('#observation-exclusions').value=this.settings.excluded_apps.join('\n');document.querySelector('#observation-status').textContent=snapshot.status;
		const changes=snapshot.changes||snapshot.candidates.map(candidate=>({id:candidate.id,revision:candidate.revision,candidate}));const present=new Set(changes.map(row=>row.id));for(const [id,row]of this.rows)if(!present.has(id)&&(this.updated.get(id)||0)<=started)this.change({epoch:this.epoch,change:{id,revision:row.revision+1,candidate:null}});
		for(const change of changes)this.change({epoch:this.epoch,change});this.empty();
	}
	async configure(value){
		const settings=value||{enabled:document.querySelector('#observation-enabled').checked,notifications:document.querySelector('#observation-notifications').checked,threshold:Number(document.querySelector('#observation-threshold').value),retention_days:Number(document.querySelector('#observation-retention').value),excluded_apps:[...new Set(document.querySelector('#observation-exclusions').value.split('\n').map(value=>value.trim()).filter(Boolean))]};
		const result=await this.invoke('configure',settings);if(result.epoch<this.epoch)return;this.epoch=result.epoch;for(const change of result.changes||[])this.change({epoch:result.epoch,change});this.settings=settings;document.querySelector('#observation-status').textContent=settings.enabled?'Waiting for a supported editable field':'Disabled';await Swal.fire({toast:true,position:'bottom-end',icon:'success',title:'Settings saved',showConfirmButton:false,timer:2000});
	}
	change(envelope){
		if(envelope.epoch<this.epoch)return;this.epoch=envelope.epoch;const {id,revision,candidate}=envelope.change;if(revision<=(this.revisions.get(id)||0))return;this.revisions.set(id,revision);this.updated.set(id,++this.changeSequence);
		let node=[...this.list.children].find(node=>node.dataset.id===id);
		if(!candidate){this.rows.delete(id);node?.remove();this.empty();return;}
		this.rows.set(id,candidate);if(!node){node=document.querySelector('#suggestion-template').content.firstElementChild.cloneNode(true);node.dataset.id=id;this.list.append(node);}
		node.querySelector('.suggestion-count').textContent=`You typed this ${candidate.count} times. Create a snippet?`;node.querySelector('.suggestion-text').textContent=candidate.text;
		node.querySelector('.suggestion-create').onclick=event=>this.run(event.currentTarget,()=>this.edit(id));
		for(const action of ['dismiss','ignore'])node.querySelector('.suggestion-'+action).onclick=event=>this.run(event.currentTarget,async()=>{const row=this.rows.get(id);if(row)this.change(await this.invoke(action,{id,revision:row.revision}));});this.empty();
	}
	empty(){document.querySelector('#suggestions-empty').hidden=this.rows.size>0;}
	async edit(id){
		if(this.draft&&this.draft.id!==id){const answer=await Swal.fire({title:'Replace this draft?',text:'Your unsaved edits will be discarded.',showCancelButton:true,confirmButtonText:'Replace',reverseButtons:true});if(!answer.isConfirmed)return;}
		const row=this.rows.get(id);if(!row)return;const epoch=this.epoch;const libraries=await this.invoke('libraries');if(epoch!==this.epoch||!this.rows.has(id))return;if(!libraries.length)throw Error('Create a writable library in Typerelay first. Your suggestion is kept.');
		this.draft={...row};document.querySelector('#suggestion-title').value='';document.querySelector('#suggestion-abbreviation').value='';document.querySelector('#suggestion-text').value=row.text;
		const select=document.querySelector('#suggestion-library');for(const option of [...select.options].slice(1))option.remove();for(const library of libraries){const option=document.querySelector('#suggestion-library-option').content.firstElementChild.cloneNode(true);option.value=library.id;option.textContent=library.name+' · '+(library.shared?'Shared':library.synced?'Synced':'Local only');select.append(option);}select.value='';
		document.querySelector('#suggestion-editor').hidden=false;document.querySelector('#suggestion-title').focus();
	}
	cancel(){const id=this.draft?.id;this.draft=null;document.querySelector('#suggestion-editor').hidden=true;document.querySelector('#suggestion-text').value='';const node=[...this.list.children].find(node=>node.dataset.id===id);(node?.querySelector('.suggestion-create')||document.querySelector('#suggestion-heading')).focus();}
	async save(){
		if(!this.draft)return;const draft={replace:document.querySelector('#suggestion-text').value,title:document.querySelector('#suggestion-title').value,trigger:document.querySelector('#suggestion-abbreviation').value,type:'plain_text',language:'plain_text',variables:{}};
		const result=await this.invoke('save',{id:this.draft.id,revision:this.rows.get(this.draft.id)?.revision??this.draft.revision,library:document.querySelector('#suggestion-library').value,draft});this.change(result);this.cancel();await Swal.fire({toast:true,position:'bottom-end',icon:'success',title:'Snippet saved',showConfirmButton:false,timer:2000});
	}
	forgotten(epoch){if(epoch<this.epoch)return;this.epoch=epoch;this.sequence++;for(const node of [...this.list.children])node.remove();this.rows.clear();this.revisions.clear();this.updated.clear();this.cancel();this.empty();}
	async forget(){const answer=await Swal.fire({title:'Forget learned text?',text:'Delete observed candidates, counts, and ignored phrases on this device. Saved snippets are kept. Observation continues if enabled.',showCancelButton:true,confirmButtonText:'Forget',reverseButtons:true});if(!answer.isConfirmed)return;const result=await this.invoke('forget');this.forgotten(result.epoch);}
}
