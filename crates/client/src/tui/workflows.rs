use super::*;
use serde_json::{Value, json};
use typerelay_client::{database::Database, editor::Paths, sync::Sync};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Action { Connect, Disconnect, Enroll, ImportYaml, ImportBundle, ImportEspanso, Export, Drafts, Recovery, Conflicts, Personal, Language, Indent, Validate, MigrateCheck, Migrate, Help, SaveAsNew, Review, DraftExport, DraftDestination, MergeConflict }
impl Action {
    pub(super) fn label(self) -> &'static str { match self {
        Self::Connect=>"Connect · browser sign-in", Self::Disconnect=>"Disconnect · keep local libraries", Self::Enroll=>"Enroll current library for sync", Self::ImportYaml=>"Import YAML", Self::ImportBundle=>"Import bundle with images", Self::ImportEspanso=>"Convert Espanso to YAML", Self::Export=>"Export current library · YAML or bundle", Self::Drafts=>"Drafts · resume or preserve", Self::Recovery=>"Recovery · rejected sync edits", Self::Conflicts=>"Conflicts · review and resolve", Self::Personal=>"Personal abbreviation", Self::Language=>"Code language", Self::Indent=>"Code indentation", Self::Validate=>"Validate local libraries", Self::MigrateCheck=>"Preview legacy YAML migration", Self::Migrate=>"Apply legacy YAML migration (creates backups)", Self::Help=>"Help · shortcuts and desktop/web workflows", Self::SaveAsNew=>"Save editor draft as new", Self::Review=>"Review current saved version", Self::DraftExport=>"Export draft · YAML or .typerelay.zip", Self::DraftDestination=>"Draft destination library", Self::MergeConflict=>"Merge conflict · edit proposed text",
    } }
}
#[derive(Clone)]
enum Mode { Commands, Drafts, Recovery, Conflicts, Form(Action), Choose(Action), Confirm, Message }
pub(super) struct Workflow {
    mode: Mode,
    rows: Vec<Value>,
    state: ListState,
    fields: Vec<TextArea<'static>>,
    labels: Vec<String>,
    focus: usize,
    context: Value,
    title: String,
    text: String,
    buttons: Vec<(Rect, KeyCode)>,
    list: Rect,
    areas: Vec<Rect>,
    scroll: u16,
}
impl Workflow {
    fn new(mode: Mode, title: &str) -> Self { let mut state=ListState::default();state.select(Some(0));Self { mode, rows:Vec::new(), state, fields:Vec::new(), labels:Vec::new(), focus:0, context:Value::Null, title:title.into(), text:String::new(), buttons:Vec::new(), list:Rect::default(), areas:Vec::new(), scroll:0 } }
    pub(super) fn commands() -> Self {
        let mut result=Self::new(Mode::Commands,"Commands · arrows / enter · esc closes");
        result.rows=[Action::Connect,Action::Disconnect,Action::Enroll,Action::ImportYaml,Action::ImportBundle,Action::ImportEspanso,Action::Export,Action::Drafts,Action::Recovery,Action::Conflicts,Action::Personal,Action::Language,Action::Indent,Action::Validate,Action::MigrateCheck,Action::Migrate,Action::Help,Action::SaveAsNew,Action::Review,Action::DraftExport,Action::DraftDestination].iter().enumerate().map(|(i,action)|json!({"label":action.label(),"action":i})).collect();result.fields.push(TextArea::default());result
    }
    pub(super) fn editor_commands() -> Self {let mut view=Self::commands();view.context=json!({"editor":true});view.rows.retain(|row|matches!(row["action"].as_u64(),Some(7|11|12|16|17|18|19|20)));view}
    pub(super) fn drafts(drafts: Vec<Draft>) -> Self { let mut result=Self::new(Mode::Drafts,"Drafts · resolve each before navigation · q quits preserving all");result.rows=drafts.iter().map(|draft|json!({"label":format!("{} · {} · {}",draft.updated_at,draft.file.name,draft.entry.label()),"draft":draft})).collect();result }
    pub(super) fn form(action: Action, fields: &[(&str,String)], context: Value) -> Self { let mut result=Self::new(Mode::Form(action),action.label());result.labels=fields.iter().map(|(name,_)|(*name).into()).collect();result.fields=fields.iter().map(|(_,text)|App::text(text)).collect();result.context=context;result }
    pub(super) fn message(title: &str, text: impl Into<String>) -> Self { let mut result=Self::new(Mode::Message,title);result.text=text.into();result }
    pub(super) fn selected(&self) -> Result<Value> { self.rows.get(self.state.selected().unwrap_or(0)).cloned().context("Select an item first") }
}
impl App {
    pub(super) fn refresh_draft(&mut self) -> Result<()> {
        self.check_identity()?;
        self.refresh_saved_draft()
    }
    fn refresh_saved_draft(&mut self) -> Result<()> {
        let Some(previous)=self.draft_record.clone() else{return Ok(());};
        let db=Database::open(&self.store.directory)?;
        if let Some(stored)=db.drafts(&self.identity)?.into_iter().find(|row|row.id==previous.id) {
            anyhow::ensure!(stored.entry==previous.entry && stored.updated_at==previous.updated_at,"Draft changed outside this terminal; reload it");
            if let Some(file)=&mut self.file {file.id=stored.file.id.clone();}
            if self.move_destination==previous.destination{self.move_destination=stored.destination.clone();}
            self.draft_record=Some(stored);
        } else {
            self.draft_record=None;self.draft_lock=None;self.file=None;self.original_entry=None;self.title=TextArea::default();self.trigger=TextArea::default();self.expansion=TextArea::default();self.variables.clear();self.workflow=None;self.pending=None;self.screen=Screen::Files;
            if !self.quit {self.show_drafts()?;}self.message("Draft removed by permanent purge or another operation",true);
        }
        Ok(())
    }
    pub(super) fn verify_draft(&self, draft: &Draft) -> Result<()> { self.check_identity()?;anyhow::ensure!(Database::open(&self.store.directory)?.drafts(&self.identity)?.iter().any(|row|serde_json::to_value(row).ok()==serde_json::to_value(draft).ok()),"Draft changed or was removed; reload Drafts");Ok(()) }
    pub(super) fn check_identity(&self) -> Result<()> { anyhow::ensure!(Draft::identity(self.settings.config_dir())?==self.identity,"Connection changed in another session. Quit and reopen; drafts remain isolated by account and server");Ok(()) }
    pub(crate) fn persist_draft(&mut self, force: bool) -> Result<()> {
        if !matches!(self.effective_screen(),Screen::Edit|Screen::Image) || self.file.is_none() || (!force && !self.dirty() && self.draft_record.is_none()) { return Ok(()); }
        if !self.quit {self.check_identity()?;}
        self.refresh_saved_draft()?;
        if self.file.is_none(){return Ok(());}
        let entry=self.draft();
        if self.draft_record.as_ref().is_some_and(|draft|draft.entry==entry&&draft.destination==self.move_destination) { return Ok(()); }
        let mut draft=self.draft_record.clone().unwrap_or_else(||Draft::new(self.file.as_ref().unwrap(),self.editing,entry.clone(),self.move_destination.clone()));
        if self.draft_lock.is_none() { self.draft_lock=Some(Draft::claim(&self.store.directory,&draft.id)?); }
        draft.entry=entry;draft.destination=self.move_destination.clone();draft.updated_at=chrono::Utc::now().to_rfc3339();
        Database::open(&self.store.directory)?.put_draft(&self.identity,&draft,self.draft_record.as_ref())?;
        self.draft_record=Some(draft);
        Ok(())
    }
    pub(crate) fn quit_preserving(&mut self) -> Result<()> {
        self.quit=true;self.cancel_operation();
        self.persist_draft(false).context("Quitting: latest edits were NOT stored; existing durable drafts remain")?;
        self.message(if self.draft_record.is_some(){"Draft preserved under its original account; quitting"}else{"Quitting"},false);
        Ok(())
    }
    pub(super) fn discard_active(&mut self) -> Result<()> {
        self.check_identity()?;
        if let Some(draft)=&self.draft_record { Database::open(&self.store.directory)?.discard_draft(&self.identity,draft)?; }
        self.draft_record=None;self.draft_lock=None;Ok(())
    }
    pub(super) fn save_snippet(&mut self, as_new: bool) -> Result<()> {
        self.persist_draft(true)?;
        let draft=self.draft_record.as_ref().context("No draft to save")?;
        if !as_new && let Some(id)=&draft.conflict {return self.start_operation(Action::MergeConflict,json!({"id":id,"choice":"merged","value":draft.entry.value(),"draft":draft}));}
        let saved=Database::open(&self.store.directory)?.save_draft(&self.identity,draft,as_new)?;
        self.original_entry=Some(draft.entry.clone());self.file=Some(saved);self.editing=None;self.move_destination=None;self.draft_record=None;self.draft_lock=None;
        self.screen=if std::mem::take(&mut self.global_edit){Screen::Files}else{Screen::Browse};
        self.reload_files()?;self.rebuild_global_hits();self.snippets_state.select(Some(0));self.selected_ids.clear();self.selection_anchor=None;
        self.message("Saved locally. Enrolled-library changes are queued for background sync.",false);
        if self.draft_gate { self.show_drafts()?; }
        Ok(())
    }
    pub(super) fn show_drafts(&mut self) -> Result<()> {
        self.check_identity()?;let rows=Draft::available(&self.store.directory,Database::open(&self.store.directory)?.drafts(&self.identity)?)?;
        self.draft_gate=!rows.is_empty();self.workflow=Some(Workflow::drafts(rows));
        if !self.draft_gate { self.workflow=None;self.screen=Screen::Files;self.reload_files()?;self.message("All drafts resolved",false); }
        Ok(())
    }
    pub(super) fn resume_draft(&mut self, draft: Draft) -> Result<()> {
        self.check_identity()?;let lock=Draft::claim(&self.store.directory,&draft.id)?;
        anyhow::ensure!(Database::open(&self.store.directory)?.drafts(&self.identity)?.iter().any(|row|row.id==draft.id&&row.updated_at==draft.updated_at),"Draft changed; reopen Drafts");
        self.file=Some(draft.file.clone());self.editing=(!draft.file.ids.is_empty()).then_some(0);self.original_entry=draft.file.entries.first().cloned();
        self.title=Self::text(&draft.entry.title);self.trigger=Self::text(&draft.entry.trigger);self.expansion=Self::text(&draft.entry.replace);self.language=draft.entry.language.clone();self.variables=draft.entry.variables.clone();self.code=draft.entry.kind=="code";self.rich=draft.entry.kind=="rich_text";self.template=draft.entry.kind=="template";self.rich_preview=false;self.move_destination=draft.destination.clone();self.editor_focus=1;self.screen=Screen::Edit;self.workflow=None;self.draft_record=Some(draft);self.draft_lock=Some(lock);self.writing_undo.clear();self.message("Draft resumed. Commands: save as new, destination, code settings, or export.",false);Ok(())
    }
    pub(super) fn show_recovery(&mut self) -> Result<()> {
        let rows=Database::open(&self.store.directory)?.recovery()?;
        let mut view=Workflow::new(Mode::Recovery,"Recovery · server-rejected edits · preserve before dismissal");
        view.rows=rows.into_iter().map(|mut row|{row["label"]=json!(format!("{} · {}",row["library_name"].as_str().unwrap_or("Unavailable library"),row["reason"].as_str().unwrap_or("Rejected edit")));row}).collect();self.workflow=Some(view);Ok(())
    }
    pub(super) fn recovered_entry(row: &Value) -> Result<Match> {
        let data=&row["data"];
        let value=[&data["value"],&data["record"],&data["item"]["value"],data].into_iter().find(|value|value["content"].is_object()).context("This recovery contains an operation; export it before dismissal")?;
        Database::entries(&[json!({"state":"active","trigger":value["trigger"],"title":value["title"],"content":value["content"]})])?.into_iter().next().context("No recoverable snippet")
    }
    pub(super) fn current_name(&self) -> Result<String> { if self.screen==Screen::Files {self.file_state.selected().and_then(|i|i.checked_sub(1)).and_then(|i|self.files.get(i)).map(|file|file.name.clone())}else{self.file.as_ref().map(|file|file.name.clone())}.context("Select a library first") }
    pub(super) fn cancel_operation(&mut self) { if let Some((cancelled,_))=&self.operation { cancelled.store(true,std::sync::atomic::Ordering::SeqCst); } }
    pub(super) fn operation_tick(&mut self) -> bool {
        let result=self.operation.as_ref().and_then(|(_,receiver)|receiver.try_recv().ok());
        if let Some(result)=result {
            self.operation=None;let resolving=self.draft_record.is_some()&&self.screen==Screen::Files;
            if resolving {self.draft_record=None;self.draft_lock=None;}
            match result {Ok(message)=>{if let Ok(identity)=Draft::identity(self.settings.config_dir()){self.identity=identity;}self.refresh();if resolving{let _=self.show_drafts();}self.message(message,false);},Err(error)=>{if resolving{let _=self.show_drafts();}self.message(format!("{error:#}"),true);}}
            return true;
        }false
    }
    pub(super) fn start_operation(&mut self, action: Action, context: Value) -> Result<()> {
        self.check_identity()?;
        anyhow::ensure!(self.operation.is_none(),"An operation is running; use Cancel operation in Commands (esc)");
        let root=self.settings.config_dir().to_path_buf();let directory=self.store.directory.clone();let cancelled=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));let signal=cancelled.clone();let(sender,receiver)=std::sync::mpsc::channel();
        std::thread::spawn(move||{let result=(||{let identity=Draft::identity(&root)?;let sync=Sync::new(root,directory.clone())?;match action {Action::Connect=>sync.connect_cancellable(context["server"].as_str().context("Server URL required")?,true,false,&signal)?,Action::Disconnect=>sync.disconnect()?,Action::Enroll=>sync.enroll(context["name"].as_str().context("Library required")?)?,Action::Conflicts|Action::MergeConflict=>sync.resolve_conflict(context["id"].as_str().context("Conflict required")?,context["choice"].as_str().context("Choice required")?,context.get("value").cloned())?,_=>anyhow::bail!("Unsupported operation")};if let Some(draft)=context.get("draft"){let draft:Draft=serde_json::from_value(draft.clone())?;Database::open(&directory)?.discard_draft(&identity,&draft)?;}Ok(format!("{} complete",action.label()))})();let _=sender.send(result);});
        self.operation=Some((cancelled,receiver));self.workflow=None;if matches!(action,Action::Connect|Action::Disconnect|Action::MergeConflict){self.screen=Screen::Files;}self.message("Operation running · ctrl+p, esc cancels browser authentication · terminal remains responsive",false);Ok(())
    }
    pub(super) fn command(&mut self, action: Action) -> Result<()> {
        let db=Database::open(&self.store.directory)?;
        match action {
            Action::SaveAsNew=>{anyhow::ensure!(self.screen==Screen::Edit,"Open a draft first");self.workflow=None;self.save_snippet(true)?;},
            Action::Review=>{let file=self.file.as_ref().context("Open a saved snippet first")?;let id=self.editing.and_then(|index|file.ids.get(index)).context("New snippet has no saved version")?;let record=db.records(&file.id)?.into_iter().find(|row|row["id"]==*id).context("Snippet moved or removed")?;self.workflow=Some(Workflow::message("Current saved version · your draft is unchanged",format!("{}\n{}",record["title"].as_str().unwrap_or(""),record["content"]["text"].as_str().or(record["content"]["markdown"].as_str()).unwrap_or("Removed"))));},
            Action::DraftExport|Action::DraftDestination=>{anyhow::ensure!(self.screen==Screen::Edit,"Open a draft first");self.persist_draft(true)?;let draft=self.draft_record.as_ref().context("Draft unavailable")?;self.workflow=Some(Workflow::form(action,&[(if action==Action::DraftExport{"New destination path (.yml or .typerelay.zip)"}else{"Existing destination library"},String::new())],json!({"draft":draft,"active":true})));},
            Action::Drafts=>{self.persist_draft(false)?;self.draft_record=None;self.draft_lock=None;self.screen=Screen::Files;self.show_drafts()?;},
            Action::Recovery=>self.show_recovery()?,
            Action::Help=>self.workflow=Some(Workflow::message("Help","ctrl+p Commands · ctrl+s Save locally · ctrl+q Quit · F1 Libraries · F2 Add · F5 Sync · F6 Settings · F7 Trash · F8 Destination · F9 Type · F10 Copy · F11 Variables · F12 Recovery / rich preview.\n\nDrafts: resume, save, save as new, copy, export, confirmed discard. Quit preserves unresolved drafts.\n\nWeb: account, billing and team administration use the server website (configured in Settings). Desktop: text expansion engine, OS permissions and autostart use the desktop app. CLI-only: run, doctor (Linux session/tools), install/uninstall and hidden setup/update/input-access/clipboard/internal database tools. Legacy migrate and validate are available here. Espanso conversion outputs YAML; import that YAML to create a library.\n\nCode: choose Language and Indentation in Commands. Tab inserts indentation; Enter carries the current line indentation.\n\nSync status is separate from local-save status. Network errors do not prevent local saves.")),
            Action::Validate=>self.workflow=Some(Workflow::message("Validation",format!("Valid: {} snippets",db.snapshot()?.len()))),
            Action::Connect|Action::Disconnect=>{
                anyhow::ensure!(self.draft_record.is_none()&&db.drafts(&self.identity)?.is_empty(),"Resolve drafts before changing connection");
                if action==Action::Connect { self.workflow=Some(Workflow::form(action,&[("Server origin",self.settings.settings.sync_url.clone())],Value::Null)); }
                else { let mut view=Workflow::new(Mode::Confirm,"Disconnect this device? Local libraries are retained.");view.context=json!({"disconnect":true});self.workflow=Some(view); }
            },
            Action::Enroll=>{let name=self.current_name()?;self.start_operation(action,json!({"name":name}))?;},
            Action::ImportYaml|Action::ImportBundle=>self.workflow=Some(Workflow::form(action,&[("Source path",String::new()),("New library name",String::new())],Value::Null)),
            Action::ImportEspanso=>self.workflow=Some(Workflow::form(action,&[("Espanso source path",String::new()),("New YAML destination path",String::new())],Value::Null)),
            Action::Export=>{let name=self.current_name()?;self.workflow=Some(Workflow::form(action,&[("Destination path (.yml or .typerelay.zip)",String::new())],json!({"name":name})));},
            Action::MigrateCheck|Action::Migrate=>self.workflow=Some(Workflow::form(action,&[("Legacy YAML file or directory",String::new())],Value::Null)),
            Action::Language|Action::Indent=>{
                anyhow::ensure!(self.screen==Screen::Edit&&self.code,"Open a code snippet first");let mut view=Workflow::new(Mode::Choose(action),action.label());
                view.rows=if action==Action::Language { ["plain_text","javascript","typescript","python","rust","go","java","c","cpp","csharp","ruby","php","swift","kotlin","sql","shell","html","css","json","yaml","markdown"].iter().map(|value|json!({"label":value,"value":value})).collect() } else {vec![json!({"label":"Tabs","value":"\t"}),json!({"label":"2 spaces","value":"  "}),json!({"label":"4 spaces","value":"    "})]};self.workflow=Some(view);
            },
            Action::Personal=>{
                let file=self.file.as_ref().context("Open a shared library first")?;let index=if self.screen==Screen::Edit{self.editing}else{self.selected()}.context("Select a saved snippet")?;let id=&file.ids[index];let personal=db.personal(id)?;
                self.workflow=Some(Workflow::form(action,&[("Personal abbreviation (empty resets to shared)",personal["trigger"].as_str().unwrap_or("").into()),("Conflict ID (optional)",String::new())],json!({"library":file.id,"id":id,"revision":personal["revision"],"details":personal})));self.workflow.as_mut().unwrap().text=format!("Shared: {}\nPersonal conflicts/rejection: {}",file.entries[index].trigger,serde_json::to_string_pretty(&personal)?);
            },
            Action::Conflicts=>{let mut view=Workflow::new(Mode::Conflicts,"Conflicts · l local · s server · m merge text");view.rows=typerelay_client::panel::Panel::conflicts(&self.store.directory)?.as_array().cloned().unwrap_or_default().into_iter().map(|mut row|{row["label"]=json!(format!("{} · {}",row["library_name"].as_str().unwrap_or("Library"),row["snippet"].as_str().unwrap_or("Snippet")));row}).collect();self.workflow=Some(view);},
            _=>(),
        }Ok(())
    }
    pub(super) fn submit_form(&mut self, action: Action, values: Vec<String>, context: Value) -> Result<()> {
        let db=Database::open(&self.store.directory)?;
        let first=values.first().map(String::as_str).unwrap_or("");
        match action {
            Action::Connect=>return self.start_operation(action,json!({"server":first})),
            Action::ImportYaml=>{db.import(&values[1],&std::fs::read_to_string(first)?)?;},
            Action::ImportBundle=>{db.import_bundle(&values[1],std::path::Path::new(first))?;},
            Action::ImportEspanso=>{let(imported,warnings)=typerelay_client::config::FileStore::convert_espanso(std::path::Path::new(first),std::path::Path::new(&values[1]))?;self.workflow=Some(Workflow::message("Espanso converted",format!("{imported} static snippets converted. {} skipped. Import the new YAML to create a library.\n{}",warnings.len(),warnings.join("\n"))));return Ok(());},
            Action::Export=>db.export(context["name"].as_str().context("Library required")?,std::path::Path::new(first))?,
            Action::DraftExport=>{
                if !context["draft"].is_null() {let draft:Draft=serde_json::from_value(context["draft"].clone())?;self.verify_draft(&draft)?;db.export_entries(&draft.file.name,&[draft.entry],std::path::Path::new(first))?;}
                else {anyhow::ensure!(db.recovery()?.iter().any(|row|row["id"]==context["recovery"]["id"]),"Recovery removed; reopen Recovery");Paths::atomic_write(std::path::Path::new(first),serde_json::to_string_pretty(&context["recovery"])?.as_bytes(),true)?;let id=context["recovery"]["id"].as_str().context("Recovery ID missing")?;db.set_meta(&format!("tui_recovery_preserved:{id}"),&json!(true))?;}
            },
            Action::DraftDestination=>{
                let destination=db.editor(first)?;db.editable(&destination.id)?;
                if let Some(draft)=context.get("draft").filter(|draft|!draft.is_null()&&context["active"]!=true) {self.resume_draft(serde_json::from_value(draft.clone())?)?;}
                self.move_destination=Some(destination.id);self.persist_draft(true)?;
            },
            Action::Personal=>db.personal_edit(context["library"].as_str().context("Library required")?,context["id"].as_str().context("Snippet required")?,(!first.is_empty()).then_some(first),context["revision"].as_i64().unwrap_or(0),values.get(1).filter(|value|!value.is_empty()).map(String::as_str))?,
            Action::MigrateCheck|Action::Migrate=>{
                let report=typerelay_client::migration::Migration::run(std::path::Path::new(first),&self.settings.config_dir().join("settings.yml"),action==Action::MigrateCheck)?;
                self.workflow=Some(Workflow::message(action.label(),serde_json::to_string_pretty(&report)?));return Ok(());
            },
            _=>(),
        }
        self.workflow=None;self.refresh();self.message(format!("{} complete",action.label()),false);
        if self.draft_gate && self.screen!=Screen::Edit {self.show_drafts()?;}
        Ok(())
    }
    pub(super) fn workflow_event(&mut self, event: Event) -> Result<()> {
        let mut view=self.workflow.take().context("No dialog")?;
        let event=if let Event::Mouse(mouse)=&event {
            if mouse.kind==MouseEventKind::Down(MouseButton::Left) {
                if let Some((_,key))=view.buttons.iter().find(|(area,_)|area.contains(Position::new(mouse.column,mouse.row))) {Event::Key(if *key==KeyCode::Enter&&matches!(view.mode,Mode::Form(_)){KeyEvent::new(KeyCode::Char('s'),KeyModifiers::CONTROL)}else{KeyEvent::new(*key,KeyModifiers::NONE)})}
                else {if view.list.contains(Position::new(mouse.column,mouse.row)) {let index=usize::from(mouse.row.saturating_sub(view.list.y+1))+view.state.offset();if index<view.rows.len(){view.state.select(Some(index));}}
                    if let Some(index)=view.areas.iter().position(|area|area.contains(Position::new(mouse.column,mouse.row))){view.focus=index;}self.workflow=Some(view);return Ok(());}
            }else if matches!(mouse.kind,MouseEventKind::ScrollDown|MouseEventKind::ScrollUp){Event::Key(KeyEvent::new(if mouse.kind==MouseEventKind::ScrollDown{KeyCode::Down}else{KeyCode::Up},KeyModifiers::NONE))}else{self.workflow=Some(view);return Ok(());}
        }else{event};
        let key=if let Event::Key(key)=&event { if key.kind==KeyEventKind::Release {self.workflow=Some(view);return Ok(());}Some(*key) } else {None};
        let code=key.map(|key|key.code);
        if key.is_some_and(|key|key.modifiers.contains(KeyModifiers::CONTROL)&&key.code==KeyCode::Char('q')) || (!matches!(view.mode,Mode::Form(_)|Mode::Commands)&&code==Some(KeyCode::Char('q'))) {self.workflow=Some(view);return self.quit_preserving();}
        if code==Some(KeyCode::Esc) {
            if self.operation.is_some() {self.cancel_operation();self.message("Authentication cancellation requested",false);}
            if matches!(view.mode,Mode::Drafts) {self.workflow=Some(view);return Ok(());}
            if self.draft_gate && self.screen!=Screen::Edit {self.show_drafts()?;}return Ok(());
        }
        // Keep the view on every operation failure; users can retry, cancel, or quit.
        self.workflow=Some(view);
        let mode=self.workflow.as_ref().unwrap().mode.clone();
        match mode {
            Mode::Commands if matches!(code,Some(KeyCode::Char(_)|KeyCode::Backspace|KeyCode::Delete)) || matches!(&event,Event::Paste(_)) => {
                let view=self.workflow.as_mut().unwrap();Self::single_input(&mut view.fields[0],event);let query=Self::value(&view.fields[0]).to_lowercase();view.rows=if view.context["editor"]==true{Workflow::editor_commands()}else{Workflow::commands()}.rows.into_iter().filter(|row|row["label"].as_str().unwrap_or("").to_lowercase().contains(&query)).collect();view.state.select(Some(0));
            },
            Mode::Form(action)=>{
                if code==Some(KeyCode::Enter) || key.is_some_and(|key|key.code==KeyCode::Char('s')&&key.modifiers.contains(KeyModifiers::CONTROL)) {
                    let view=self.workflow.as_ref().unwrap();return self.submit_form(action,view.fields.iter().map(Self::value).collect(),view.context.clone());
                }
                let view=self.workflow.as_mut().unwrap();
                if matches!(code,Some(KeyCode::Tab|KeyCode::BackTab)) {view.focus=(view.focus+if code==Some(KeyCode::BackTab){view.fields.len()-1}else{1})%view.fields.len();}
                else{Self::single_input(&mut view.fields[view.focus],event);}
            },
            Mode::Confirm=>{
                if matches!(code,Some(KeyCode::Char('y')|KeyCode::Enter)) {
                    let context=self.workflow.as_ref().unwrap().context.clone();
                    if context["disconnect"]==true {return self.start_operation(Action::Disconnect,Value::Null);}
                    if let Some(draft)=context.get("draft") {let draft:Draft=serde_json::from_value(draft.clone())?;let _lock=Draft::claim(&self.store.directory,&draft.id)?;self.check_identity()?;Database::open(&self.store.directory)?.discard_draft(&self.identity,&draft)?;self.show_drafts()?;}
                    else if let Some(id)=context["recovery"].as_str() {let db=Database::open(&self.store.directory)?;anyhow::ensure!(db.meta(&format!("tui_recovery_preserved:{id}"))?==Some(json!(true)),"Copy, export or save this recovery first");db.dismiss_recovery(id)?;self.show_recovery()?;}
                    else if context["id"].is_string() {return self.start_operation(Action::Conflicts,context);}
                }
            },
            Mode::Message=>{if matches!(code,Some(KeyCode::Down|KeyCode::PageDown)){self.workflow.as_mut().unwrap().scroll=self.workflow.as_ref().unwrap().scroll.saturating_add(3);}else if matches!(code,Some(KeyCode::Up|KeyCode::PageUp)){self.workflow.as_mut().unwrap().scroll=self.workflow.as_ref().unwrap().scroll.saturating_sub(3);}else if code==Some(KeyCode::Enter) {self.workflow=None;if self.draft_gate&&self.screen!=Screen::Edit{self.show_drafts()?;}}},
            _=>{
                if matches!(code,Some(KeyCode::PageUp|KeyCode::PageDown)){let view=self.workflow.as_mut().unwrap();view.scroll=if code==Some(KeyCode::PageUp){view.scroll.saturating_sub(3)}else{view.scroll.saturating_add(3)};return Ok(());}
                if matches!(code,Some(KeyCode::Up|KeyCode::Down)) {let view=self.workflow.as_mut().unwrap();let index=view.state.selected().unwrap_or(0);let next=if matches!(code,Some(KeyCode::Up|KeyCode::PageUp)){index.saturating_sub(1)}else{(index+1).min(view.rows.len().saturating_sub(1))};view.state.select(Some(next));view.scroll=0;return Ok(());}
                if code.is_none(){return Ok(());}
                let row=self.workflow.as_ref().unwrap().selected()?;
                match mode {
                    Mode::Commands if code==Some(KeyCode::Enter)=>{let actions=[Action::Connect,Action::Disconnect,Action::Enroll,Action::ImportYaml,Action::ImportBundle,Action::ImportEspanso,Action::Export,Action::Drafts,Action::Recovery,Action::Conflicts,Action::Personal,Action::Language,Action::Indent,Action::Validate,Action::MigrateCheck,Action::Migrate,Action::Help,Action::SaveAsNew,Action::Review,Action::DraftExport,Action::DraftDestination];self.command(actions[row["action"].as_u64().unwrap_or(0)as usize])?;},
                    Mode::Choose(action) if code==Some(KeyCode::Enter)=>{if action==Action::Language{self.language=row["value"].as_str().unwrap().into();}else{self.indent=row["value"].as_str().unwrap().into();}self.workflow=None;self.persist_draft(false)?;},
                    Mode::Drafts=>{
                        let draft:Draft=serde_json::from_value(row["draft"].clone())?;self.verify_draft(&draft)?;
                        match code.unwrap() {
                            KeyCode::Enter=>self.resume_draft(draft)?,
                            KeyCode::Char('s'|'n')=>{self.resume_draft(draft)?;self.save_snippet(code==Some(KeyCode::Char('n')))?;},
                            KeyCode::Char('c')=>{self.check_identity()?;typerelay_client::clipboard::PasteJob::copy_text(draft.entry.replace)?;self.message("Draft copied; retained until save or discard",false);},
                            KeyCode::Char('e')=>self.workflow=Some(Workflow::form(Action::DraftExport,&[("New destination path (.yml or .typerelay.zip)",String::new())],row)),
                            KeyCode::Char('l')=>self.workflow=Some(Workflow::form(Action::DraftDestination,&[("Existing destination library",String::new())],row)),
                            KeyCode::Char('d')=>{let mut view=Workflow::new(Mode::Confirm,"Discard this draft permanently? y confirms · esc cancels");view.context=row;self.workflow=Some(view);},
                            _=>(),
                        }
                    },
                    Mode::Recovery=>{anyhow::ensure!(Database::open(&self.store.directory)?.recovery()?.iter().any(|current|current["id"]==row["id"]),"Recovery removed; reopen Recovery");match code.unwrap() {
                        KeyCode::Char('c')=>{typerelay_client::clipboard::PasteJob::copy_text(serde_json::to_string_pretty(&row["data"])?)?;Database::open(&self.store.directory)?.set_meta(&format!("tui_recovery_preserved:{}",row["id"].as_str().context("Missing ID")?),&json!(true))?;self.message("Recovery copied; d explicitly dismisses",false);},
                        KeyCode::Char('e')=>self.workflow=Some(Workflow::form(Action::DraftExport,&[("New JSON export path",String::new())],json!({"recovery":row}))),
                        KeyCode::Char('r')|KeyCode::Enter=>{
                            let entry=Self::recovered_entry(&row)?;let file=Database::open(&self.store.directory)?.editor(&self.current_name()?)?;let mut draft=Draft::new(&file,None,entry,None);draft.origin_library=row["library"].as_str().unwrap_or(&file.id).into();draft.origin_snippet=row["snippet"].as_str().map(str::to_owned);let db=Database::open(&self.store.directory)?;db.put_draft(&self.identity,&draft,None)?;db.set_meta(&format!("tui_recovery_preserved:{}",row["id"].as_str().context("Missing ID")?),&json!(true))?;self.draft_gate=true;self.resume_draft(draft)?;
                        },
                        KeyCode::Char('d')=>{let mut view=Workflow::new(Mode::Confirm,"Dismiss preserved recovery? y confirms · esc cancels");view.context=json!({"recovery":row["id"]});self.workflow=Some(view);},_=>(),
                    }
                    },
                    Mode::Conflicts=>match code.unwrap() {
                        KeyCode::Char('l'|'s')=>{let mut view=Workflow::new(Mode::Confirm,"Resolve conflict with selected version? y confirms · esc cancels");view.context=json!({"id":row["_id"],"choice":if code==Some(KeyCode::Char('l')){"local"}else{"server"}});self.workflow=Some(view);},
                        KeyCode::Char('m')=>{let value=["local","server","base"].iter().find_map(|key|row.get(*key).filter(|value|value["content"].is_object())).context("Conflict has no remaining version to merge")?;let entry=Self::recovered_entry(&json!({"data":value}))?;let db=Database::open(&self.store.directory)?;let file=db.editor_id(row["library"].as_str().context("Conflict library unavailable")?)?;let index=file.ids.iter().position(|id|row["snippet"]==*id);let mut draft=Draft::new(&file,index,entry,None);draft.conflict=row["_id"].as_str().map(str::to_owned);db.put_draft(&self.identity,&draft,None)?;self.draft_gate=true;self.resume_draft(draft)?;},_=>(),
                    },_=>(),
                }
            }
        }Ok(())
    }
    pub(super) fn draw_workflow(&mut self, frame: &mut Frame, area: Rect) {
        let view=self.workflow.as_mut().unwrap();view.buttons.clear();view.areas.clear();
        let form=matches!(view.mode,Mode::Form(_));
        let labels:Vec<(&str,KeyCode)>=match view.mode {
            Mode::Drafts=>vec![("Resume",KeyCode::Enter),("Save [s]",KeyCode::Char('s')),("New [n]",KeyCode::Char('n')),("Copy [c]",KeyCode::Char('c')),("Export [e]",KeyCode::Char('e')),("Library [l]",KeyCode::Char('l')),("Discard [d]",KeyCode::Char('d')),("Quit [q]",KeyCode::Char('q'))],
            Mode::Recovery=>vec![("Resume [r]",KeyCode::Char('r')),("Copy [c]",KeyCode::Char('c')),("Export [e]",KeyCode::Char('e')),("Dismiss [d]",KeyCode::Char('d')),("Back",KeyCode::Esc)],
            Mode::Conflicts=>vec![("Local [l]",KeyCode::Char('l')),("Server [s]",KeyCode::Char('s')),("Merge [m]",KeyCode::Char('m')),("Back",KeyCode::Esc)],
            Mode::Confirm=>vec![("Confirm [y]",KeyCode::Char('y')),("Cancel",KeyCode::Esc)],
            Mode::Form(_)=>vec![("Submit",KeyCode::Enter),("Cancel",KeyCode::Esc)],
            _=>vec![("Choose",KeyCode::Enter),("Back / cancel auth",KeyCode::Esc)],
        };
        let mut button_rects=Vec::new();let mut x=0;let mut y=0;
        for(label,_)in &labels {let width=(label.chars().count()as u16+2).min(area.width);if x>0&&x+width>area.width{x=0;y+=1;}button_rects.push(Rect::new(x,y,width,1));x+=width;}
        let rows=Layout::vertical([Constraint::Length(2),Constraint::Min(1),Constraint::Length(y+1),Constraint::Length(2)]).split(area);
        frame.render_widget(Paragraph::new(if matches!(view.mode,Mode::Commands){format!("Commands · type to filter: {}",Self::value(&view.fields[0]))}else{view.title.clone()}).wrap(Wrap{trim:false}).style(Style::default().fg(Color::Cyan)),rows[0]);
        for(index,(label,key))in labels.iter().enumerate(){let mut rect=button_rects[index];rect.x+=rows[2].x;rect.y+=rows[2].y;rect=rect.intersection(area);frame.render_widget(Paragraph::new(*label).style(Style::default().fg(Color::Yellow)),rect);view.buttons.push((rect,*key));}
        frame.render_widget(Paragraph::new(format!("{}{}",self.status,if self.operation.is_some(){" · operation running"}else{""})).wrap(Wrap{trim:false}).style(Style::default().fg(if self.error{Color::Red}else{Color::Gray})),rows[3]);
        if form {
            let details=Layout::vertical([Constraint::Min(3),Constraint::Length(if view.text.is_empty(){0}else{5})]).split(rows[1]);frame.render_widget(Paragraph::new(view.text.clone()).wrap(Wrap{trim:false}),details[1]);let available=details[0];let count=view.fields.len();let compact=available.height<(count as u16*3+2);
            if compact {let index=view.focus;view.fields[index].set_block(Self::border(format!("{} · tab next · ctrl+s submits",view.labels[index]),true));frame.render_widget(&view.fields[index],available);view.areas=vec![Rect::default();count];view.areas[index]=available;}
            else {let parts=Layout::vertical((0..count).map(|index|if index+1==count{Constraint::Min(3)}else{Constraint::Length(3)})).split(available);for(index,field)in view.fields.iter_mut().enumerate(){field.set_block(Self::border(view.labels[index].clone(),view.focus==index));frame.render_widget(&*field,parts[index]);view.areas.push(parts[index]);}}
        } else if matches!(view.mode,Mode::Message|Mode::Confirm) {frame.render_widget(Paragraph::new(view.text.clone()).scroll((view.scroll,0)).wrap(Wrap{trim:false}),rows[1]);}
        else {
            let parts=Layout::vertical([Constraint::Percentage(45),Constraint::Percentage(55)]).split(rows[1]);view.list=parts[0];
            let items=view.rows.iter().map(|row|ListItem::new(row["label"].as_str().unwrap_or("Item"))).collect::<Vec<_>>();frame.render_stateful_widget(List::new(items).block(Self::border("Select · ↑/↓",true)).highlight_style(Style::default().bg(Color::DarkGray)),parts[0],&mut view.state);
            let detail=view.selected().ok().map(|row|match view.mode {
                Mode::Drafts=>serde_json::from_value::<Draft>(row["draft"].clone()).map(|draft|format!("{} · {}\n{}\n{}",draft.entry.kind,draft.entry.language,draft.entry.trigger,draft.entry.replace)).unwrap_or_default(),
                Mode::Recovery=>Self::recovered_entry(&row).map(|entry|format!("{}\n{}\n{}",row["reason"].as_str().unwrap_or(""),entry.label(),entry.replace)).unwrap_or_else(|_|format!("{}\nOperation record: copy or export the complete record before dismissal",row["reason"].as_str().unwrap_or(""))),
                Mode::Conflicts=>["base","local","server"].iter().map(|key|{let value=&row[*key];format!("{}: {}\n{}",key,value["title"].as_str().unwrap_or(""),value["content"]["text"].as_str().or(value["content"]["markdown"].as_str()).unwrap_or("(deleted or unavailable)"))}).collect::<Vec<_>>().join("\n"),
                _=>"Enter chooses · Esc cancels · Ctrl+Q quits".into(),
            }).unwrap_or_else(||"No items".into());frame.render_widget(Paragraph::new(detail).scroll((view.scroll,0)).wrap(Wrap{trim:false}),parts[1]);
        }
    }
    pub(super) fn draw_compact(&mut self, frame: &mut Frame, area: Rect) {
        self.toolbar.clear();self.field_areas.clear();self.confirm_buttons.clear();self.save_area=Rect::default();self.cancel_area=Rect::default();
        let rows=Layout::vertical([Constraint::Min(1),Constraint::Length(1)]).split(area);
        if self.screen==Screen::Confirm {
            let destructive=self.pending_delete.is_some()||self.pending_trash.is_some()||self.pending_batch.is_some()||self.pending_merge.is_some();
            let text=if destructive{"Confirm action · use the labeled shortcut or Esc to cancel"}else{"Unsaved changes · s Save · d Discard · Esc Cancel · q Quit preserving draft"};
            frame.render_widget(Paragraph::new(format!("{text}\n{}",self.status)).wrap(Wrap{trim:false}),rows[0]);
            let labels:Vec<&str>=if self.pending_merge.is_some(){vec!["Merge [m]","Cancel [esc]"]}else if let Some((_,destination,_))=&self.pending_batch{vec![if destination.is_some(){"Move [m]"}else{"Trash [d]"},"Cancel [esc]"]}else if let Some((action,_))=&self.pending_trash{vec![if action=="restore"{"Restore [r]"}else if action=="purge"{"Empty [e]"}else{"Trash [d]"},"Cancel [esc]"]}else if self.pending_delete.is_some(){vec!["Trash [d]","Cancel [esc]"]}else{vec!["Save [s]","Discard [d]","Cancel [esc]"]};
            self.confirm_buttons=Layout::horizontal(labels.iter().map(|_|Constraint::Ratio(1,labels.len()as u32))).split(rows[1]).to_vec();
            for(index,label)in labels.iter().enumerate(){frame.render_widget(Paragraph::new(*label),self.confirm_buttons[index]);}
        }else{frame.render_widget(Paragraph::new(format!("TypeRelay · Ctrl+P Commands · Ctrl+S Save · Ctrl+Q Quit\n{}\n{}",self.status,if self.screen==Screen::Edit{Self::value(&self.expansion)}else{String::new()})).wrap(Wrap{trim:false}),area);}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(root:&std::path::Path)->App {App::new(EditorStore::new(root.join("snippets")).unwrap(),SettingsStore::open(root.join("settings.yml")).unwrap()).unwrap()}
    fn key(app:&mut App,code:KeyCode,modifiers:KeyModifiers){app.handle(Event::Key(KeyEvent::new(code,modifiers)));}
    fn new_draft(app:&mut App,text:&str){app.file=Some(app.store.create("Local").unwrap());app.screen=Screen::Browse;app.edit(true).unwrap();app.editor_focus=1;app.handle(Event::Paste(text.into()));}
    #[test]
    fn restart_gates_navigation_and_quit_preserves_until_save() {
        let root=tempfile::tempdir().unwrap();let mut first=app(root.path());new_draft(&mut first,"Restart draft");let db=Database::open(&first.store.directory).unwrap();assert_eq!(db.drafts(&Value::Null).unwrap()[0].entry.replace,"Restart draft");
        let second=app(root.path());assert!(!second.draft_gate,"Active terminal draft must not be hijacked");drop(first);let mut recovered=app(root.path());assert!(recovered.draft_gate);key(&mut recovered,KeyCode::F(1),KeyModifiers::NONE);assert!(recovered.workflow.is_some());key(&mut recovered,KeyCode::Esc,KeyModifiers::NONE);assert!(recovered.workflow.is_some());key(&mut recovered,KeyCode::Char('q'),KeyModifiers::NONE);assert!(recovered.quit);assert_eq!(db.drafts(&Value::Null).unwrap().len(),1);drop(recovered);
        let mut recovered=app(root.path());key(&mut recovered,KeyCode::Enter,KeyModifiers::NONE);assert_eq!(recovered.draft().replace,"Restart draft");key(&mut recovered,KeyCode::Char('s'),KeyModifiers::CONTROL);assert!(db.drafts(&Value::Null).unwrap().is_empty());assert_eq!(db.editor("Local").unwrap().entries.len(),1);assert!(!recovered.draft_gate);
    }
    #[test]
    fn failed_save_confirmation_keeps_keyboard_mouse_and_small_exit_usable() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());new_draft(&mut app,"Draft text");app.trigger=App::text("INVALID");key(&mut app,KeyCode::Char('q'),KeyModifiers::CONTROL);assert_eq!(app.screen,Screen::Confirm);key(&mut app,KeyCode::Char('s'),KeyModifiers::NONE);assert_eq!(app.screen,Screen::Confirm);assert!(app.error);
        let mut terminal=ratatui::Terminal::new(ratatui::backend::TestBackend::new(40,10)).unwrap();terminal.draw(|frame|app.draw(frame)).unwrap();let text=terminal.backend().buffer().content().iter().map(|cell|cell.symbol()).collect::<String>();assert!(text.contains("Save [s]"));assert!(text.contains("Discard [d]"));let cancel=app.confirm_buttons[2];app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent{kind:MouseEventKind::Down(MouseButton::Left),column:cancel.x,row:cancel.y,modifiers:KeyModifiers::NONE}));assert_eq!(app.screen,Screen::Edit);
        key(&mut app,KeyCode::Char('q'),KeyModifiers::CONTROL);key(&mut app,KeyCode::Char('s'),KeyModifiers::NONE);key(&mut app,KeyCode::Char('d'),KeyModifiers::NONE);assert!(app.quit);assert!(Database::open(&app.store.directory).unwrap().drafts(&Value::Null).unwrap().is_empty());
    }
    #[test]
    fn stale_save_preserves_draft_and_palette_save_as_new_keeps_newer_version() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());let db=Database::open(&app.store.directory).unwrap();let file=db.import("Local","matches: [{replace: Original}]").unwrap();app.file=Some(file.clone());app.screen=Screen::Browse;app.snippets_state.select(Some(0));app.edit(false).unwrap();app.expansion=App::text("My edit");app.persist_draft(true).unwrap();db.edit(&file,Some(0),Some(Match{replace:"Other edit".into(),..Default::default()})).unwrap();key(&mut app,KeyCode::Esc,KeyModifiers::NONE);key(&mut app,KeyCode::Char('s'),KeyModifiers::NONE);assert_eq!(app.screen,Screen::Confirm);key(&mut app,KeyCode::Esc,KeyModifiers::NONE);key(&mut app,KeyCode::Char('p'),KeyModifiers::CONTROL);app.handle(Event::Paste("save editor draft as new".into()));key(&mut app,KeyCode::Enter,KeyModifiers::NONE);assert_eq!(db.editor("Local").unwrap().entries.iter().map(|entry|entry.replace.as_str()).collect::<Vec<_>>(),vec!["Other edit","My edit"]);
    }
    #[test]
    fn drafts_view_renders_actions_at_small_sizes_and_confirms_discard() {
        let root=tempfile::tempdir().unwrap();let mut first=app(root.path());new_draft(&mut first,"Keep or discard");drop(first);let mut app=app(root.path());let mut terminal=ratatui::Terminal::new(ratatui::backend::TestBackend::new(40,14)).unwrap();terminal.draw(|frame|app.draw(frame)).unwrap();let text=terminal.backend().buffer().content().iter().map(|cell|cell.symbol()).collect::<String>();for label in ["Save [s]","New [n]","Export [e]","Discard [d]","Quit [q]"]{assert!(text.contains(label),"missing {label}");}key(&mut app,KeyCode::Char('d'),KeyModifiers::NONE);key(&mut app,KeyCode::Esc,KeyModifiers::NONE);assert!(app.draft_gate);key(&mut app,KeyCode::Char('d'),KeyModifiers::NONE);key(&mut app,KeyCode::Char('y'),KeyModifiers::NONE);assert!(!app.draft_gate);
    }
    #[test]
    fn commands_filter_import_export_validate_and_code_controls_use_services() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());let yaml=root.path().join("in.yml");std::fs::write(&yaml,"matches: [{replace: Imported}]").unwrap();app.submit_form(Action::ImportYaml,vec![yaml.to_string_lossy().into(),"Imported".into()],Value::Null).unwrap();app.file=Some(app.store.open("Imported").unwrap());let bundle=root.path().join("out.typerelay.zip");app.submit_form(Action::Export,vec![bundle.to_string_lossy().into()],json!({"name":"Imported"})).unwrap();assert!(bundle.exists());app.command(Action::Validate).unwrap();assert!(app.workflow.as_ref().unwrap().text.contains("Valid: 0"));app.workflow=None;app.screen=Screen::Browse;app.snippets_state.select(Some(0));app.edit(false).unwrap();app.code=true;
        key(&mut app,KeyCode::Char('p'),KeyModifiers::CONTROL);app.handle(Event::Paste("code language".into()));assert_eq!(app.workflow.as_ref().unwrap().rows.len(),1);key(&mut app,KeyCode::Enter,KeyModifiers::NONE);app.workflow.as_mut().unwrap().state.select(Some(4));key(&mut app,KeyCode::Enter,KeyModifiers::NONE);assert_eq!(app.language,"rust");app.command(Action::Indent).unwrap();app.workflow.as_mut().unwrap().state.select(Some(1));key(&mut app,KeyCode::Enter,KeyModifiers::NONE);app.editor_focus=1;app.expansion=App::text("");key(&mut app,KeyCode::Tab,KeyModifiers::NONE);assert_eq!(App::value(&app.expansion),"  ");
    }
    #[test]
    fn recovery_dismiss_requires_preservation_and_export_does_not_overwrite() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());let db=Database::open(&app.store.directory).unwrap();db.recover("library",Some("snippet"),&json!({"value":{"content":{"version":1,"type":"plain_text","text":"Rejected"}}}),"Access revoked").unwrap();app.show_recovery().unwrap();key(&mut app,KeyCode::Char('d'),KeyModifiers::NONE);key(&mut app,KeyCode::Char('y'),KeyModifiers::NONE);assert!(app.error);assert_eq!(db.recovery().unwrap().len(),1);key(&mut app,KeyCode::Esc,KeyModifiers::NONE);app.show_recovery().unwrap();key(&mut app,KeyCode::Char('e'),KeyModifiers::NONE);let output=root.path().join("recovery.json");app.handle(Event::Paste(output.to_string_lossy().into()));key(&mut app,KeyCode::Enter,KeyModifiers::NONE);assert!(output.exists());app.show_recovery().unwrap();key(&mut app,KeyCode::Char('d'),KeyModifiers::NONE);key(&mut app,KeyCode::Char('y'),KeyModifiers::NONE);assert!(db.recovery().unwrap().is_empty());
    }
    #[test]
    fn account_switch_hides_old_drafts_and_active_identity_change_rejects_write() {
        let root=tempfile::tempdir().unwrap();std::fs::create_dir(root.path().join("sync")).unwrap();let path=root.path().join("sync/credentials.json");std::fs::write(&path,json!({"server":"https://one.invalid","account":"one"}).to_string()).unwrap();let mut first=app(root.path());new_draft(&mut first,"Private draft");std::fs::write(&path,json!({"server":"https://one.invalid","account":"two"}).to_string()).unwrap();first.expansion=App::text("Changed");assert!(first.persist_draft(false).is_err());drop(first);let second=app(root.path());assert!(!second.draft_gate);
    }
    #[test]
    fn purge_scrubs_open_editor_and_cannot_resurrect_draft() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());let db=Database::open(&app.store.directory).unwrap();let file=db.import("Local","matches: [{replace: Original}]").unwrap();app.file=Some(file.clone());app.screen=Screen::Browse;app.snippets_state.select(Some(0));app.edit(false).unwrap();app.expansion=App::text("Unsaved private edit");app.persist_draft(true).unwrap();db.edit(&file,Some(0),None).unwrap();db.empty(&db.trash().unwrap()).unwrap();app.refresh();assert_eq!(app.screen,Screen::Files);assert!(App::value(&app.expansion).is_empty());assert!(app.draft_record.is_none());assert!(db.drafts(&Value::Null).unwrap().is_empty());
    }
    #[test]
    fn merged_conflict_edits_are_durable_when_resolution_fails() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());let db=Database::open(&app.store.directory).unwrap();let file=db.import("Local","matches: [{replace: Server}]").unwrap();let local=Match{replace:"Local proposal".into(),..Default::default()}.value();db.set_meta("conflicts",&json!([{"_id":"conflict","library":file.id,"snippet":file.ids[0],"local":local,"server":file.entries[0].value(),"base":local}])).unwrap();
        app.command(Action::Conflicts).unwrap();key(&mut app,KeyCode::Char('m'),KeyModifiers::NONE);assert_eq!(app.screen,Screen::Edit);assert_eq!(app.draft_record.as_ref().unwrap().conflict.as_deref(),Some("conflict"));app.expansion=App::text("Reviewed merge");key(&mut app,KeyCode::Char('s'),KeyModifiers::CONTROL);assert!(app.operation.is_some());
        for _ in 0..100 {if app.operation.is_none(){break;}std::thread::sleep(std::time::Duration::from_millis(5));app.ai_tick();}
        assert!(app.operation.is_none());assert!(app.error);assert_eq!(db.drafts(&Value::Null).unwrap()[0].entry.replace,"Reviewed merge");assert_eq!(db.editor("Local").unwrap().entries[0].replace,"Server");assert!(app.workflow.is_some());
    }
    #[test]
    fn autosave_failure_never_labels_latest_changes_durable() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());new_draft(&mut app,"Stored");let db=Database::open(&app.store.directory).unwrap();db.connection.execute_batch("CREATE TRIGGER fail_draft BEFORE UPDATE ON tui_drafts BEGIN SELECT RAISE(ABORT,'write failed'); END;").unwrap();app.handle(Event::Paste(" new text".into()));assert!(app.error);assert!(app.status.contains("Draft NOT saved"));assert!(app.sync_status().contains("Latest changes NOT stored"));assert_eq!(db.drafts(&Value::Null).unwrap()[0].entry.replace,"Stored");
    }
    #[test]
    fn pending_authentication_cancels_without_blocking_commands_or_quit() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());let(cancel_sender,cancel_receiver)=std::sync::mpsc::channel();let cancelled=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));app.operation=Some((cancelled.clone(),cancel_receiver));key(&mut app,KeyCode::Char('p'),KeyModifiers::CONTROL);key(&mut app,KeyCode::Esc,KeyModifiers::NONE);assert!(cancelled.load(std::sync::atomic::Ordering::SeqCst));cancel_sender.send(Err(anyhow::anyhow!("Authentication cancelled"))).unwrap();app.ai_tick();assert!(app.operation.is_none());key(&mut app,KeyCode::Char('q'),KeyModifiers::CONTROL);assert!(app.quit);
    }

    #[test]
    fn live_editor_adopts_enrollment_remap_without_losing_new_keystrokes() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());new_draft(&mut app,"Before remap");let db=Database::open(&app.store.directory).unwrap();let old=app.file.as_ref().unwrap().id.clone();db.remap(&old,"server-library").unwrap();app.handle(Event::Paste(" after remap".into()));assert!(!app.error,"{}",app.status);assert_eq!(app.file.as_ref().unwrap().id,"server-library");assert_eq!(db.drafts(&Value::Null).unwrap()[0].entry.replace,"Before remap after remap");key(&mut app,KeyCode::Char('s'),KeyModifiers::CONTROL);assert_eq!(db.editor_id("server-library").unwrap().entries[0].replace,"Before remap after remap");assert!(db.drafts(&Value::Null).unwrap().is_empty());
    }

    #[test]
    fn changed_account_can_quit_and_preserve_latest_text_only_under_original_identity() {
        for through_confirmation in [true,false] {
            let root=tempfile::tempdir().unwrap();std::fs::create_dir(root.path().join("sync")).unwrap();let path=root.path().join("sync/credentials.json");std::fs::write(&path,json!({"server":"https://one.invalid","account":"one"}).to_string()).unwrap();let mut app=app(root.path());new_draft(&mut app,"Before account change");let original=app.identity.clone();std::fs::write(&path,json!({"server":"https://two.invalid","account":"two"}).to_string()).unwrap();app.handle(Event::Paste(" plus latest text".into()));assert!(app.error);
            if through_confirmation {key(&mut app,KeyCode::Char('q'),KeyModifiers::CONTROL);assert_eq!(app.screen,Screen::Confirm);key(&mut app,KeyCode::Char('q'),KeyModifiers::NONE);}else{key(&mut app,KeyCode::Char('p'),KeyModifiers::CONTROL);key(&mut app,KeyCode::Char('q'),KeyModifiers::CONTROL);}
            assert!(app.quit);assert!(!app.error,"{}",app.status);let db=Database::open(&app.store.directory).unwrap();assert_eq!(db.drafts(&original).unwrap()[0].entry.replace,"Before account change plus latest text");assert!(db.drafts(&Draft::identity(root.path()).unwrap()).unwrap().is_empty());app.quit_preserving().unwrap();
        }
    }
    #[test]
    fn quit_still_exits_after_storage_failure_without_claiming_latest_text_saved() {
        let root=tempfile::tempdir().unwrap();let mut app=app(root.path());new_draft(&mut app,"Durable text");let db=Database::open(&app.store.directory).unwrap();db.connection.execute_batch("CREATE TRIGGER fail_exit BEFORE UPDATE ON tui_drafts BEGIN SELECT RAISE(ABORT,'disk failed'); END;").unwrap();app.handle(Event::Paste(" not durable".into()));key(&mut app,KeyCode::Char('q'),KeyModifiers::CONTROL);key(&mut app,KeyCode::Char('q'),KeyModifiers::NONE);assert!(app.quit);assert!(app.error);assert!(app.status.contains("NOT saved"));assert!(app.sync_status().contains("Latest changes NOT stored"));assert_eq!(db.drafts(&Value::Null).unwrap()[0].entry.replace,"Durable text");assert!(app.quit_preserving().is_err());
    }

}
