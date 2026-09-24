use anyhow::{Result, Context};
use ratatui::{Frame, layout::{Constraint, Layout, Rect, Position}, style::{Color, Modifier, Style}, text::Line, widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap}};
use ratatui::crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui_textarea::TextArea;
use typerelay_core::Engine;
use typerelay_client::{config::Match, editor::{EditorStore, OpenFile}, settings::SettingsStore};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen { Files, Browse, Edit, Image, NewFile, Settings, Trash, Move, Confirm }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Destination { Files, Browse, Settings, Trash, Quit }

#[derive(Clone, Debug, PartialEq, Eq)]
struct GlobalHit { library_id: String, snippet_id: String, file_index: usize, entry_index: usize }

pub struct App {
    store: EditorStore,
    settings: SettingsStore,
    pub screen: Screen,
    files: Vec<OpenFile>,
    file_state: ListState,
    global_search: TextArea<'static>,
    global_search_focused: bool,
    global_hits: Vec<GlobalHit>,
    global_state: ListState,
    global_edit: bool,
    snippets_state: ListState,
    file: Option<OpenFile>,
    search: TextArea<'static>,
    search_focused: bool,
    trigger: TextArea<'static>,
    title: TextArea<'static>,
    language: String,
    code: bool,
    template: bool,
	rich: bool,
	rich_preview: bool,
	rich_image:Option<ratatui_image::protocol::Protocol>,
	image_source:TextArea<'static>,
	image_alt:TextArea<'static>,
	image_title:TextArea<'static>,
	image_width:TextArea<'static>,
	image_focus:usize,
    variables: std::collections::BTreeMap<String,typerelay_core::template::Variable>,
    template_dialog: Option<crate::template_dialog::Dialog>,
    fill_base: Option<(String,i64)>,
	rich_fill: Option<serde_json::Value>,
    preview_x: u16,
    expansion: TextArea<'static>,
    name: TextArea<'static>,
    url: TextArea<'static>,
    editor_focus: usize,
    editing: Option<usize>,
    original_entry: Option<Match>,
    original_url: String,
    prefix: TextArea<'static>,
    original_prefix: String,
    pending: Option<Destination>,
    pending_delete: Option<usize>,
    selected_ids: std::collections::BTreeSet<String>,
    selection_anchor: Option<String>,
    move_destination: Option<String>,
    move_choices: Vec<serde_json::Value>,
    move_state: ListState,
    move_from: Screen,
    move_items: Vec<serde_json::Value>,
    pending_batch: Option<(String, Option<String>, Vec<serde_json::Value>)>,
	pending_merge:Option<(String,String,usize)>,
    bulk_buttons: Vec<Rect>,
    pending_trash: Option<(String, Vec<serde_json::Value>)>,
    trash_rows: Vec<serde_json::Value>,
    trash_state: ListState,
    trash_buttons: Vec<Rect>,
    confirm_from: Screen,
    status: String,
    error: bool,
    pub quit: bool,
    toolbar: Vec<Rect>,
    list_area: Rect,
    field_areas: Vec<Rect>,
    save_area: Rect,
    cancel_area: Rect,
    confirm_buttons: Vec<Rect>,
	merge_button:Rect,
}

impl App {
    pub fn new(store: EditorStore, settings: SettingsStore) -> Result<Self> {
        let files = Self::load_files(&store)?;
        let mut file_state = ListState::default();
        file_state.select(Some(0));
        Ok(Self { store, settings, screen: Screen::Files, files, file_state, global_search: TextArea::default(), global_search_focused: false, global_hits: Vec::new(), global_state: ListState::default(), global_edit: false, snippets_state: ListState::default(), file: None, search: TextArea::default(), search_focused: false, trigger: TextArea::default(), title: TextArea::default(), language: "plain_text".into(), code: false, template:false, rich:false, rich_preview:false,rich_image:None,image_source:TextArea::default(),image_alt:TextArea::default(),image_title:TextArea::default(),image_width:Self::text("640"),image_focus:0, variables:Default::default(), template_dialog:None, fill_base:None, rich_fill:None, preview_x: 0, expansion: TextArea::default(), name: TextArea::default(), url: TextArea::default(), editor_focus: 0, editing: None, original_entry: None, original_url: String::new(), prefix: TextArea::default(), original_prefix: String::new(), pending: None, pending_delete: None, selected_ids: std::collections::BTreeSet::new(), selection_anchor: None, move_destination: None, move_choices: Vec::new(), move_state: ListState::default(), move_from: Screen::Browse, move_items: Vec::new(), pending_batch: None,pending_merge:None, bulk_buttons: Vec::new(), pending_trash: None, trash_rows: Vec::new(), trash_state: ListState::default(), trash_buttons: Vec::new(), confirm_from: Screen::Files, status: "Choose a file, or create a new one".into(), error: false, quit: false, toolbar: Vec::new(), list_area: Rect::default(), field_areas: Vec::new(), save_area: Rect::default(), cancel_area: Rect::default(), confirm_buttons: Vec::new(),merge_button:Rect::default() })
    }
    fn load_files(store: &EditorStore) -> Result<Vec<OpenFile>> { store.files()?.iter().map(|name| store.open(name)).collect() }
    fn text(value: &str) -> TextArea<'static> { TextArea::new(value.split('\n').map(str::to_owned).collect()) }
    fn value(field: &TextArea<'_>) -> String { field.lines().join("\n") }
    fn global_active(&self) -> bool { !Self::value(&self.global_search).is_empty() }
    fn selected_global(&self) -> Option<&GlobalHit> { self.global_hits.get(self.global_state.selected()?) }
    fn rebuild_global_hits(&mut self) {
        let selected = self.selected_global().map(|hit| (hit.library_id.clone(), hit.snippet_id.clone()));
        let query = Self::value(&self.global_search);
        self.global_hits = if query.is_empty() { Vec::new() } else {
            self.files.iter().enumerate().flat_map(|(file_index, file)| {
                file.search(&query).into_iter().map(move |entry_index| GlobalHit {
                    library_id: file.id.clone(), snippet_id: file.ids[entry_index].clone(), file_index, entry_index,
                })
            }).collect()
        };
        let index = selected.and_then(|(library_id, snippet_id)| self.global_hits.iter().position(|hit| hit.library_id == library_id && hit.snippet_id == snippet_id)).unwrap_or(0);
        self.global_state.select((!self.global_hits.is_empty()).then_some(index));
    }
    fn reload_files(&mut self) -> Result<()> {
        self.files = Self::load_files(&self.store)?;
        if self.file_state.selected().is_some_and(|index| index > self.files.len()) { self.file_state.select(Some(self.files.len())); }
        self.rebuild_global_hits();
        Ok(())
    }
    fn library_label(&self, file: &OpenFile) -> String {
        let label = typerelay_client::sync::Sync::label(self.settings.config_dir(), &self.store.directory, &file.name);
        format!("{} ({}){}", file.name, file.entries.len(), label.strip_prefix(&file.name).unwrap_or(""))
    }
    fn draft(&self) -> Match { let replacement=Self::value(&self.expansion);let dynamic=self.template||(!self.code&&!self.rich&&(!self.variables.is_empty()||replacement.contains("{{")));Match { variables: self.variables.clone(), trigger: Self::value(&self.trigger), replace: replacement, title: Self::value(&self.title), kind: if self.rich { "rich_text" } else if self.code { "code" } else if dynamic { "template" } else { "plain_text" }.into(), language: self.language.clone() } }
    fn next_editor_field(&mut self, backwards: bool) {
        let order = [2, 0, 1];
        let index = order.iter().position(|field| *field == self.editor_focus).unwrap_or(0);
        self.editor_focus = order[(index + if backwards { order.len() - 1 } else { 1 }) % order.len()];
    }
    fn effective_screen(&self) -> Screen { if self.screen == Screen::Confirm { self.confirm_from } else { self.screen } }
	fn html(value:&str)->String{value.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;")}
	fn preview_image(&self)->Result<Option<ratatui_image::protocol::Protocol>>{let content=self.draft().value()["content"].clone();let Some(id)=content["assets"].as_array().and_then(|ids|ids.first()).and_then(|id|id.as_str())else{return Ok(None)};let(_,bytes)=typerelay_client::database::Database::open(&self.store.directory)?.asset(id)?.context("Rich-text image is unavailable")?;let image=image::load_from_memory(&bytes)?;#[allow(deprecated)]let mut picker=ratatui_image::picker::Picker::from_fontsize(ratatui_image::FontSize::new(8,16));let environment=std::env::var("TERM").unwrap_or_default().to_lowercase();if environment.contains("kitty"){picker.set_protocol_type(ratatui_image::picker::ProtocolType::Kitty);}else if std::env::var_os("ITERM_SESSION_ID").is_some(){picker.set_protocol_type(ratatui_image::picker::ProtocolType::Iterm2);}else if environment.contains("sixel"){picker.set_protocol_type(ratatui_image::picker::ProtocolType::Sixel);}Ok(Some(picker.new_protocol(image,ratatui::layout::Size::new(40,10),ratatui_image::Resize::Fit(None))?))}
	fn image(&mut self)->Result<()>{let db=typerelay_client::database::Database::open(&self.store.directory)?;let asset=typerelay_client::assets::Assets::import(&db,&Self::value(&self.image_source))?;let alt=Self::html(&Self::value(&self.image_alt));let title=Self::html(&Self::value(&self.image_title));let width=Self::value(&self.image_width);anyhow::ensure!(width.parse::<u16>().is_ok_and(|value|(32..=2048).contains(&value)),"Image width must be 32–2048");self.expansion.insert_str(format!("<img src=\"typerelay-asset:{}\" alt=\"{alt}\" title=\"{title}\" width=\"{width}\">",asset["id"].as_str().context("Missing asset ID")?));self.screen=Screen::Edit;self.rich_preview=false;self.message("Image cached locally; synced devices download it automatically",false);Ok(())}
    fn dirty(&self) -> bool {
        match self.effective_screen() {
            Screen::Edit => self.original_entry.as_ref() != Some(&self.draft()) || self.move_destination.is_some(),
            Screen::Settings => Self::value(&self.url) != self.original_url || Self::value(&self.prefix) != self.original_prefix,
            Screen::Image=>true,
			_ => false,
        }
    }
    fn message(&mut self, text: impl Into<String>, error: bool) { self.status = text.into(); self.error = error; }
    fn filtered(&self) -> Vec<usize> { self.file.as_ref().map(|file| file.search(&Self::value(&self.search))).unwrap_or_default() }
    fn selected(&self) -> Option<usize> { self.filtered().get(self.snippets_state.selected().unwrap_or(0)).copied() }
    fn apply(&mut self, destination: Destination) -> Result<()> {
        self.pending = None;
        match destination {
            Destination::Trash => { self.load_trash()?; self.screen = Screen::Trash; }
            Destination::Quit => self.quit = true,
            Destination::Files => { self.reload_files()?; self.file_state.select(Some(0)); self.global_edit = false; self.screen = Screen::Files; }
            Destination::Browse => self.screen = if self.file.is_some() { Screen::Browse } else { Screen::Files },
            Destination::Settings => {
                self.settings.reload()?;
                self.original_url = self.settings.settings.sync_url.clone();
                self.url = Self::text(&self.original_url);
                self.original_prefix = self.settings.settings.trigger_prefix.clone();
                self.prefix = Self::text(&self.original_prefix);
                self.editor_focus = 0;
                self.screen = Screen::Settings;
            }
        }
        Ok(())
    }
    fn leave(&mut self, destination: Destination) -> Result<()> {
        if self.dirty() {
            self.confirm_from = self.screen;
            self.pending = Some(destination);
            self.screen = Screen::Confirm;
            Ok(())
        } else { self.apply(destination) }
    }
    fn open_selected_file(&mut self) -> Result<()> {
        let index = self.file_state.selected().unwrap_or(0);
        if index == 0 { self.name = TextArea::default(); self.screen = Screen::NewFile; return Ok(()); }
        let name = &self.files.get(index - 1).context("Select a file")?.name;
        let next = self.store.open(name)?;
        if self.file.as_ref().is_none_or(|file| file.id != next.id) { self.selected_ids.clear(); self.selection_anchor = None; }
        self.file = Some(next);
        self.search = TextArea::default();
        self.search_focused = false;
        self.global_edit = false;
        self.snippets_state.select(Some(0));
        self.screen = Screen::Browse;
        self.message("Enter: edit · /: search · F4: trash library · F7: Trash", false);
        Ok(())
    }
    fn open_global_hit(&mut self) -> Result<()> {
        let hit = self.selected_global().cloned().context("Select a snippet")?;
        let name = self.files.get(hit.file_index).context("Library is no longer available")?.name.clone();
        let current = self.store.open(&name)?;
        anyhow::ensure!(current.id == hit.library_id, "Library changed; search again");
        let index = current.ids.iter().position(|id| id == &hit.snippet_id).context("Snippet moved or was removed; search again")?;
        let previous_file = self.file.replace(current);
        let previous_search = std::mem::take(&mut self.search);
        let previous_state = std::mem::take(&mut self.snippets_state);
        self.snippets_state.select(Some(index));
        match self.edit(false) {
            Ok(()) => { self.global_edit = true; Ok(()) }
            Err(error) => { self.file = previous_file; self.search = previous_search; self.snippets_state = previous_state; Err(error) }
        }
    }
    fn edit(&mut self, new: bool) -> Result<()> {
        self.settings.reload()?;
        self.move_destination = None;
        let file = self.file.as_ref().context("Choose a file first")?;
        typerelay_client::sync::Sync::editable(self.settings.config_dir(), &self.store.directory, &file.name)?;
        self.editing = if new { None } else { Some(self.selected().context("Select a snippet")?) };
        let entry = self.editing.map(|index| file.entries[index].clone()).unwrap_or(Match { variables: Default::default(), trigger: String::new(), replace: String::new(), ..Match::default() });
		self.title = Self::text(&entry.title); self.language = entry.language.clone(); self.code = entry.kind == "code"; self.template=entry.kind=="template"; self.rich=entry.kind=="rich_text";self.rich_preview=false;self.rich_image=None; self.variables=entry.variables.clone();
        self.trigger = Self::text(&entry.trigger);
        self.trigger.move_cursor(ratatui_textarea::CursorMove::End);
        self.expansion = Self::text(&entry.replace); self.expansion.set_hard_tab_indent(true);
        self.original_entry = Some(entry);
        self.editor_focus = 0;
        self.screen = Screen::Edit;
        self.message("Tab / Shift+Tab switch fields · Code: F2 leaves editor · F9 Type · Ctrl+S saves", false);
        Ok(())
    }
    fn save(&mut self) -> Result<()> {
        match self.effective_screen() {
            Screen::Edit => {
                let file = self.file.as_ref().context("No file selected")?;
                let entry = self.draft();
                let saved = if let Some(destination) = &self.move_destination {
                    typerelay_client::database::Database::open(&self.store.directory)?.edit_move(file, self.editing.context("Save a new snippet before moving")?, entry.clone(), destination)?
                } else { typerelay_client::sync::Sync::editable(self.settings.config_dir(), &self.store.directory, &file.name)?; self.store.save(file, self.editing, entry.clone())? };
                self.file = Some(saved);
                self.original_entry = Some(entry);
                self.move_destination = None; self.selected_ids.retain(|id| self.file.as_ref().unwrap().ids.contains(id));
                if self.selection_anchor.as_ref().is_some_and(|id| !self.file.as_ref().unwrap().ids.contains(id)) { self.selection_anchor = None; }
                let global_edit = std::mem::take(&mut self.global_edit);
                self.screen = if global_edit { Screen::Files } else { Screen::Browse };
                if global_edit { self.reload_files()?; }
                let count = self.filtered().len();
                self.snippets_state.select(if count == 0 { None } else { Some(0) });
                self.message("Saved. The running engine reloads automatically.", false);
            }
            Screen::Settings => {
                self.settings.save(&Self::value(&self.url), &Self::value(&self.prefix))?;
                self.original_url = self.settings.settings.sync_url.clone();
                self.original_prefix = self.settings.settings.trigger_prefix.clone();
                self.screen = if self.file.is_some() { Screen::Browse } else { Screen::Files };
                self.message("Settings saved. Connect: typerelay connect --server URL · Disconnect: typerelay disconnect", false);
            }
            Screen::NewFile => {
                self.file = Some(self.store.create(Self::value(&self.name).trim())?);
                self.reload_files()?;
                self.search = TextArea::default();
                self.snippets_state.select(None);
                self.screen = Screen::Browse;
                self.message("File created. F2 adds your first snippet.", false);
            }
            _ => (),
        }
        Ok(())
    }
    fn load_trash(&mut self) -> Result<()> {
        self.trash_rows = typerelay_client::database::Database::open(&self.store.directory)?.trash()?;
        self.trash_state.select(if self.trash_rows.is_empty() { None } else { Some(self.trash_state.selected().unwrap_or(0).min(self.trash_rows.len()-1)) });
        Ok(())
    }
    fn trash_request(&mut self, action: &str) -> Result<()> {
        let db = typerelay_client::database::Database::open(&self.store.directory)?;
        let targets = if action == "trash" {
            anyhow::ensure!(self.screen == Screen::Browse, "Select a library first");
            let file = self.file.as_ref().context("Select a library first")?;
            let library = db.library(&file.id)?;
            anyhow::ensure!(library["permissions"]["manage"] == true, "Library management permission required");
            vec![serde_json::json!({"type":"library","id":file.id,"library":file.id,"revision":library["revision"]})]
        } else if action == "purge" { self.trash_rows.iter().filter(|row| row["can_purge"] == true).cloned().collect() }
        else { vec![self.trash_rows.get(self.trash_state.selected().unwrap_or(0)).context("Select a Trash item")?.clone()] };
        anyhow::ensure!(!targets.is_empty(), "No eligible Trash items");
        self.confirm_from = self.screen;
        self.pending_trash = Some((action.into(), targets));
        self.screen = Screen::Confirm;
        Ok(())
    }
    fn selected_items(&self) -> Result<Vec<serde_json::Value>> {
        let file = self.file.as_ref().context("Choose a library")?;
        let ids: Vec<String> = if self.selected_ids.is_empty() { vec![file.ids[self.selected().context("Select a snippet")?].clone()] } else { self.selected_ids.iter().cloned().collect() };
        typerelay_client::database::Database::open(&self.store.directory)?.batch_items(file, &ids)
    }
    fn select_row(&mut self, range: bool) -> Result<()> {
        let file = self.file.as_ref().context("Choose a library")?;
        typerelay_client::database::Database::open(&self.store.directory)?.editable(&file.id)?;
        let index = self.selected().context("Select a snippet")?;
        let id = file.ids[index].clone();
        let visible: Vec<_> = self.filtered().iter().map(|index|file.ids[*index].clone()).collect();
        if range {
            let anchor = self.selection_anchor.as_ref().and_then(|id|visible.iter().position(|item|item == id)).unwrap_or(self.snippets_state.selected().unwrap_or(0));
            let current = self.snippets_state.selected().unwrap_or(0);
            self.selected_ids.extend(visible[anchor.min(current)..=anchor.max(current)].iter().cloned());
            if self.selection_anchor.is_none() { self.selection_anchor = Some(id); }
        } else {
            if !self.selected_ids.remove(&id) { self.selected_ids.insert(id.clone()); }
            self.selection_anchor = Some(id);
        }
        Ok(())
    }
    fn request_move(&mut self) -> Result<()> {
        anyhow::ensure!(matches!(self.screen, Screen::Browse | Screen::Edit), "Choose a snippet first");
        let file = self.file.as_ref().context("Choose a library")?;
        let db = typerelay_client::database::Database::open(&self.store.directory)?;
        db.editable(&file.id)?;
        let mut choices = db.destinations(&file.id)?;
        self.move_items = if self.screen == Screen::Edit {
            anyhow::ensure!(self.editing.is_some(), "Save a new snippet before moving it");
            choices.insert(0, db.library(&file.id)?);
            Vec::new()
        } else { self.selected_items()? };
        anyhow::ensure!(!choices.is_empty(), "No other editable libraries with the same sync status");
        self.move_choices = choices;
        self.move_state.select(Some(0));
        self.move_from = self.screen;
        self.screen = Screen::Move;
        Ok(())
    }
	fn request_merge(&mut self)->Result<()>{anyhow::ensure!(self.screen==Screen::Files,"Open the library picker first");anyhow::ensure!(!self.global_active(),"Clear search before merging a library");let index=self.file_state.selected().unwrap_or(0);anyhow::ensure!(index>0,"Choose a library to merge");let name=&self.files.get(index-1).context("Choose a source library")?.name;let db=typerelay_client::database::Database::open(&self.store.directory)?;let source=db.editor(name)?;let mut choices=db.merge_destinations(&source.id)?;for library in &mut choices{let id=library["_id"].as_str().context("Missing destination ID")?.to_owned();library["merge_sync"]=serde_json::json!(if db.synced(&id)?{"Synced"}else{"Local only"});library["merge_count"]=serde_json::json!(db.records(&id)?.iter().filter(|record|record["state"]=="active").count());}anyhow::ensure!(!choices.is_empty(),"No eligible destination. Upload a local destination before merging a synced library into it.");self.move_choices=choices;self.move_items=vec![serde_json::json!({"source":source.id,"name":source.name,"count":source.entries.len()})];self.move_state.select(Some(0));self.move_from=Screen::Files;self.screen=Screen::Move;Ok(())}
    fn choose_move(&mut self) -> Result<()> {
        let destination = self.move_choices.get(self.move_state.selected().unwrap_or(0)).context("Choose a destination")?["_id"].as_str().context("Missing destination")?.to_owned();
		let source=if self.move_from==Screen::Files{self.move_items.first().and_then(|item|item["source"].as_str()).context("Missing merge source")?.to_owned()}else{self.file.as_ref().context("Choose a source")?.id.clone()};
        if self.move_from == Screen::Edit {
            self.move_destination = if destination == source { None } else { Some(destination) };
            self.screen = Screen::Edit;
		}else if self.move_from==Screen::Files{let count=self.move_items.first().and_then(|item|item["count"].as_u64()).unwrap_or(0)as usize;self.pending_merge=Some((source,destination,count));self.confirm_from=Screen::Move;self.screen=Screen::Confirm;
		}else {
            self.pending_batch = Some((source, Some(destination), self.move_items.clone()));
            self.confirm_from = Screen::Move;
            self.screen = Screen::Confirm;
        }
        Ok(())
    }
    fn request_delete(&mut self) -> Result<()> {
        anyhow::ensure!(self.screen == Screen::Browse, "Choose a saved snippet from the list first");
        if !self.selected_ids.is_empty() {
            self.pending_batch = Some((self.file.as_ref().unwrap().id.clone(), None, self.selected_items()?));
            self.confirm_from = Screen::Browse; self.screen = Screen::Confirm; return Ok(());
        }
        let index = self.selected().context("Select a snippet to delete")?;
        let file = self.file.as_ref().context("Choose a file first")?;
        typerelay_client::sync::Sync::editable(self.settings.config_dir(), &self.store.directory, &file.name)?;
        self.pending_delete = Some(index);
        self.confirm_from = Screen::Browse;
        self.screen = Screen::Confirm;
        Ok(())
    }
    fn confirm(&mut self, choice: usize) -> Result<()> {
		if let Some((source,destination,_))=self.pending_merge.clone(){if choice==0{let queued=typerelay_client::database::Database::open(&self.store.directory)?.merge(&source,&destination)?;if queued{let _=typerelay_client::sync::Sync::trigger(self.settings.config_dir());}self.reload_files()?;self.file_state.select(Some(0));self.screen=Screen::Files;self.message(if queued{"Merge queued"}else{"Libraries merged"},false);}else{self.screen=Screen::Files;}self.pending_merge=None;return Ok(());}
        if let Some((source, destination, items)) = self.pending_batch.clone() {
            if choice == 0 {
                typerelay_client::database::Database::open(&self.store.directory)?.batch(&source, destination.as_deref(), &items)?;
                let name = self.file.as_ref().unwrap().name.clone();
                self.file = Some(self.store.open(&name)?);
                self.selected_ids.clear(); self.selection_anchor = None; self.snippets_state.select(Some(0));
                self.screen = Screen::Browse;
                self.message(if destination.is_some() { "Selected snippets moved" } else { "Selected snippets moved to Trash" }, false);
            } else { self.screen = self.confirm_from; }
            self.pending_batch = None;
            return Ok(());
        }
        if let Some((action, targets)) = self.pending_trash.clone() {
            if choice == 0 {
                let db = typerelay_client::database::Database::open(&self.store.directory)?;
                if action == "purge" { db.empty(&targets)?; } else { db.trash_action(&targets[0], &action)?; }
                self.message(if action == "restore" { "Restored" } else if action == "purge" { "Eligible Trash items removed" } else { "Library moved to Trash" }, false);
            }
            self.pending_trash = None;
            if self.confirm_from == Screen::Trash { self.load_trash()?; self.screen = Screen::Trash; }
            else if choice == 0 { self.file = None; self.apply(Destination::Files)?; }
            else { self.screen = self.confirm_from; }
            return Ok(());
        }
        if let Some(index) = self.pending_delete {
            if choice == 0 {
                let file = self.file.as_ref().context("Choose a file first")?;
                typerelay_client::sync::Sync::editable(self.settings.config_dir(), &self.store.directory, &file.name)?;
                let saved = self.store.delete(file, index)?;
                self.file = Some(saved);
                let count = self.filtered().len();
                self.snippets_state.select(if count == 0 { None } else { Some(self.snippets_state.selected().unwrap_or(0).min(count - 1)) });
                self.message("Snippet moved to Trash. Enrolled libraries sync automatically.", false);
            }
            self.pending_delete = None;
            self.screen = Screen::Browse;
            return Ok(());
        }
        let destination = self.pending.unwrap_or(Destination::Browse);
        self.screen = self.confirm_from;
        match choice {
            0 => { self.save()?; self.apply(destination) }
            1 => self.apply(destination),
            _ => { self.pending = None; Ok(()) },
        }
    }
    fn copy_current(&mut self) -> Result<()> {
        let (entry, base) = match self.screen {
            Screen::Edit => (self.draft(), self.file.as_ref().map(|file| (file.name.clone(), file.revision))),
            Screen::Browse => {
                let file = self.file.as_ref().context("Choose a library")?;
                (file.entries[self.selected().context("Select a snippet")?].clone(), Some((file.name.clone(), file.revision)))
            }
            Screen::Files => {
                let hit = self.selected_global().context("Select a snippet")?;
                let file = &self.files[hit.file_index];
                (file.entries[hit.entry_index].clone(), Some((file.name.clone(), file.revision)))
            }
            _ => return Ok(()),
        };
        if entry.kind == "rich_text" {
            let content = entry.value()["content"].clone();
            let (result, _) = typerelay_client::panel::Panel::rich_payload(&self.store.directory, &content, Default::default(), true)?;
            if result.fields.is_empty() {
                let (result, payload) = typerelay_client::panel::Panel::rich_payload(&self.store.directory, &content, Default::default(), false)?;
                typerelay_client::clipboard::PasteJob::copy_payload(payload)?;
                self.message(if result.enter_actions > 0 { "Copied rich text; Enter key actions omitted" } else { "Copied rich text" }, false);
            } else {
                self.fill_base = base;
                self.rich_fill = Some(content);
                self.template_dialog = Some(crate::template_dialog::Dialog::fill(typerelay_core::template::Template { text: entry.replace, variables: entry.variables })?);
            }
        } else if entry.kind == "template" {
            let template = typerelay_core::template::Template { text: entry.replace.clone(), variables: entry.variables.clone() };
            if template.fields().map_err(anyhow::Error::msg)?.is_empty() {
                let rendered = typerelay_client::templates::Templates::render(&entry.value()["content"], Default::default(), false)?;
                typerelay_client::clipboard::PasteJob::copy_text(rendered.text)?;
                self.message(if rendered.enter_actions > 0 { "Copied text; Enter key actions omitted" } else { "Copied" }, false);
            } else {
                self.fill_base = base;
                self.template_dialog = Some(crate::template_dialog::Dialog::fill(template)?);
            }
        } else {
            typerelay_client::clipboard::PasteJob::copy_text(entry.replace)?;
            self.message("Copied", false);
        }
        Ok(())
    }
    fn toolbar_action(&mut self, index: usize) -> Result<()> {
        match index {
            0 => self.leave(Destination::Files),
            1 if self.screen == Screen::Browse => self.edit(true),
            1 => { self.message("Choose a library first", false); Ok(()) },
            2 => { typerelay_client::sync::Sync::trigger(self.settings.config_dir())?; self.message("Sync requested. Use typerelay sync for immediate CLI status.", false); Ok(()) },
            3 => self.leave(Destination::Settings),
            4 => self.request_delete(),
            5 => self.leave(Destination::Trash),
            _ => Ok(()),
        }
    }
    fn move_selection(&mut self, down: bool) {
        let count = if self.screen == Screen::Files { if self.global_active() { self.global_hits.len() } else { self.files.len() + 1 } } else { self.filtered().len() };
        let state = if self.screen == Screen::Files { if self.global_active() { &mut self.global_state } else { &mut self.file_state } } else { &mut self.snippets_state };
        if count == 0 { state.select(None); return; }
        let current = state.selected().unwrap_or(0);
        state.select(Some(if down { (current + 1).min(count - 1) } else { current.saturating_sub(1) }));
    }
    fn abbreviation_input(&mut self, event: Event) {
        match event {
            Event::Key(key) if key.code == KeyCode::Char(self.settings.settings.trigger_prefix.chars().next().unwrap_or(Engine::DEFAULT_PREFIX)) => (),
            Event::Paste(text) => Self::single_input(&mut self.trigger, Event::Paste(text.strip_prefix(self.settings.settings.trigger_prefix.as_str()).unwrap_or(&text).to_owned())),
            other => Self::single_input(&mut self.trigger, other),
        }
    }
    fn single_input(field: &mut TextArea<'static>, event: Event) {
        if let Event::Key(key) = &event
            && matches!(key.code, KeyCode::Enter | KeyCode::Tab) { return; }
        if let Event::Paste(text) = event { field.insert_str(text.replace(['\r', '\n', '\t'], " ")); } else { field.input(event); }
    }
    pub fn handle(&mut self, event: Event) {
        if let Err(error) = self.handle_inner(event) { self.message(format!("{error:#}"), true); }
    }
    fn handle_inner(&mut self, event: Event) -> Result<()> {
        if let Some(dialog)=&mut self.template_dialog {
            if let Some(outcome)=dialog.event(event) { match outcome {
                crate::template_dialog::Outcome::Cancel=>(),
				crate::template_dialog::Outcome::Definition{name,variable,insert}=>{if let Some(variable)=variable{self.variables.insert(name.clone(),variable);if !self.rich{self.template=true;}}
                    if insert{self.expansion.insert_str(format!("{{{{{name}}}}}"));}},
				crate::template_dialog::Outcome::Copy{rendered,values}=>{
					if let Some((name,revision))=&self.fill_base{let current=self.store.open(name)?;anyhow::ensure!(current.revision==*revision,"Library changed; reopen the template before copying");}
					if let Some(content)=self.rich_fill.take(){let(result,payload)=typerelay_client::panel::Panel::rich_payload(&self.store.directory,&content,values,false)?;typerelay_client::clipboard::PasteJob::copy_payload(payload)?;self.message(if result.enter_actions>0{"Copied rich text; Enter key actions omitted"}else{"Copied rich text"},false);}else{typerelay_client::clipboard::PasteJob::copy_text(rendered.text)?;self.message(if rendered.enter_actions>0{"Copied text; Enter key actions omitted"}else{"Copied"},false);}
				}
			} self.template_dialog=None; self.fill_base=None;self.rich_fill=None; } return Ok(());
        }
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release { return Ok(()); }
            if self.screen == Screen::Move {
                match key.code {
                    KeyCode::Esc => self.screen = self.move_from,
                    KeyCode::Enter => self.choose_move()?,
                    KeyCode::Down => self.move_state.select(Some((self.move_state.selected().unwrap_or(0)+1).min(self.move_choices.len().saturating_sub(1)))),
                    KeyCode::Up => self.move_state.select(Some(self.move_state.selected().unwrap_or(0).saturating_sub(1))),
                    _ => (),
                }
                return Ok(());
            }
            if self.screen == Screen::Confirm {
				if self.pending_merge.is_some(){return if key.code==KeyCode::Char('m'){self.confirm(0)}else if matches!(key.code,KeyCode::Esc|KeyCode::Enter){self.confirm(1)}else{Ok(())};}
                if let Some((_, destination, _)) = &self.pending_batch {
                    return if key.code == KeyCode::Char(if destination.is_some() { 'm' } else { 'd' }) { self.confirm(0) } else if matches!(key.code, KeyCode::Esc | KeyCode::Enter) { self.confirm(1) } else { Ok(()) };
                }
                if let Some((action, _)) = &self.pending_trash {
                    let expected = if action == "restore" { 'r' } else if action == "purge" { 'e' } else { 'd' };
                    return if key.code == KeyCode::Char(expected) { self.confirm(0) } else if matches!(key.code, KeyCode::Esc | KeyCode::Enter | KeyCode::Char('c')) { self.confirm(1) } else { Ok(()) };
                }
                if self.pending_delete.is_some() { return match key.code { KeyCode::Char('d') => self.confirm(0), KeyCode::Esc | KeyCode::Enter | KeyCode::Char('c') => self.confirm(1), _ => Ok(()) }; }
                return match key.code { KeyCode::Char('s') => self.confirm(0), KeyCode::Char('d') => self.confirm(1), KeyCode::Char('c') | KeyCode::Esc | KeyCode::Enter => self.confirm(2), _ => Ok(()) };
            }
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                match key.code {
					KeyCode::Char('s') if self.screen==Screen::Image=>return self.image(),
                    KeyCode::Char('a') if self.screen == Screen::Browse && !self.search_focused => {
                        let file = self.file.as_ref().context("Choose a library")?;
                        typerelay_client::database::Database::open(&self.store.directory)?.editable(&file.id)?;
                        self.selected_ids = self.filtered().iter().map(|index|file.ids[*index].clone()).collect(); self.selection_anchor = None; return Ok(());
                    }
                    KeyCode::Char('d') if self.screen == Screen::Browse && !self.search_focused => { self.selected_ids.clear(); self.selection_anchor = None; return Ok(()); }
                    KeyCode::Char('m') if self.screen == Screen::Edit => return self.request_move(),
                    KeyCode::Char('q' | 'c') => return self.leave(Destination::Quit),
                    KeyCode::Char('s') => return self.save(),
                    KeyCode::Char('t') if self.screen == Screen::Edit && self.editor_focus == 1 => { self.expansion.insert_str("\t"); return Ok(()); }
                    _ => (),
                }
            }
            match key.code {
                KeyCode::F(1) => return self.toolbar_action(0),
                KeyCode::F(2) if self.screen == Screen::Edit => { self.next_editor_field(key.modifiers.contains(KeyModifiers::SHIFT)); return Ok(()); }
                KeyCode::F(9) if self.screen == Screen::Edit => { if self.rich{self.rich=false;self.code=false;}else if self.code{self.code=false;self.rich=true;}else{self.code=true;self.rich=false;}self.template=false;self.rich_preview=false;self.message(if self.rich{"Type: Rich text · F12 source/preview · F11 variables"}else if self.code { "Type: Code · Tab indents; F2 moves to the next field" } else { "Type: Text · F11 variables" }, false); return Ok(()); }
				KeyCode::F(12) if self.screen==Screen::Edit&&self.rich=>{self.rich_preview = !self.rich_preview;self.rich_image=if self.rich_preview{self.preview_image()?}else{None};self.message(if self.rich_preview{"Rich-text preview · F12 source"}else{"Rich-text Markdown source · F12 preview"},false);return Ok(());}
				KeyCode::F(11) if self.screen == Screen::Edit && !self.code => { self.template_dialog=Some(crate::template_dialog::Dialog::variables(typerelay_core::template::Template{text:Self::value(&self.expansion),variables:self.variables.clone()})?);return Ok(()); }
                KeyCode::F(10) if matches!(self.screen, Screen::Edit | Screen::Browse) || (self.screen == Screen::Files && self.global_active()) => return self.copy_current(),
                KeyCode::F(2) => return self.toolbar_action(1),
                KeyCode::F(5) => return self.toolbar_action(2),
                KeyCode::F(6) => return self.toolbar_action(3),
                KeyCode::F(8) => return self.request_move(),
                KeyCode::F(7) => return self.toolbar_action(5),
				KeyCode::F(4) if self.screen==Screen::Edit&&self.rich=>{self.image_source=TextArea::default();self.image_alt=TextArea::default();self.image_title=TextArea::default();self.image_width=Self::text("640");self.image_focus=0;self.screen=Screen::Image;self.message("Add a local or remote image",false);return Ok(());}
                KeyCode::F(4) if self.screen == Screen::Browse => return self.trash_request("trash"),
                KeyCode::F(3) => return self.toolbar_action(4),
                _ => (),
            }
            match self.screen {
                Screen::Trash => match key.code {
                    KeyCode::Esc => self.apply(Destination::Files)?,
                    KeyCode::Char('r') | KeyCode::Enter => self.trash_request("restore")?,
                    KeyCode::Char('e') => self.trash_request("purge")?,
                    KeyCode::Down => { if !self.trash_rows.is_empty() { self.trash_state.select(Some((self.trash_state.selected().unwrap_or(0)+1).min(self.trash_rows.len()-1))); } }
                    KeyCode::Up => self.trash_state.select(Some(self.trash_state.selected().unwrap_or(0).saturating_sub(1))),
                    _ => (),
                },
                Screen::Files => match key.code {
                    KeyCode::Right if self.global_active() && !self.global_search_focused => self.preview_x = self.preview_x.saturating_add(4),
                    KeyCode::Left if self.global_active() && !self.global_search_focused => self.preview_x = self.preview_x.saturating_sub(4),
                    KeyCode::Down => self.move_selection(true),
                    KeyCode::Up => self.move_selection(false),
                    KeyCode::Esc if self.global_search_focused => self.global_search_focused = false,
                    KeyCode::Esc => self.leave(Destination::Quit)?,
                    KeyCode::Enter if self.global_search_focused => self.global_search_focused = false,
                    KeyCode::Enter if self.global_active() => self.open_global_hit()?,
                    KeyCode::Enter => self.open_selected_file()?,
                    KeyCode::Char('/') if !self.global_search_focused => self.global_search_focused = true,
                    KeyCode::Tab => self.global_search_focused = !self.global_search_focused,
                    _ if self.global_search_focused => { Self::single_input(&mut self.global_search, Event::Key(key)); self.rebuild_global_hits(); }
                    KeyCode::Char('j') => self.move_selection(true),
                    KeyCode::Char('k') => self.move_selection(false),
					KeyCode::Char('m') if !self.global_active() => self.request_merge()?,
                    _ => (),
                },
                Screen::Browse => match key.code {
                    KeyCode::Down | KeyCode::Up if key.modifiers.contains(KeyModifiers::SHIFT) && !self.search_focused => {
                        if self.selection_anchor.is_none() { self.selection_anchor = self.selected().map(|index|self.file.as_ref().unwrap().ids[index].clone()); }
                        self.move_selection(key.code == KeyCode::Down); self.select_row(true)?;
                    }
                    KeyCode::Right if !self.search_focused => self.preview_x = self.preview_x.saturating_add(4),
                    KeyCode::Left if !self.search_focused => self.preview_x = self.preview_x.saturating_sub(4),
                    KeyCode::Char(' ') if !self.search_focused => self.select_row(false)?,
                    KeyCode::Down => self.move_selection(true), KeyCode::Up => self.move_selection(false),
                    KeyCode::Esc if self.search_focused => self.search_focused = false,
                    KeyCode::Esc => self.leave(Destination::Files)?,
                    KeyCode::Enter if self.search_focused => self.search_focused = false,
                    KeyCode::Enter => self.edit(false)?,
                    KeyCode::Delete if !self.search_focused => self.request_delete()?,
                    KeyCode::Char('/') if !self.search_focused => self.search_focused = true,
                    KeyCode::Tab => self.search_focused = !self.search_focused,
                    _ if self.search_focused => { Self::single_input(&mut self.search, Event::Key(key)); self.snippets_state.select(Some(0)); }
                    _ => (),
                },
                Screen::Edit => match key.code {
                    KeyCode::Esc => self.leave(if self.global_edit { Destination::Files } else { Destination::Browse })?,
                    KeyCode::Tab if self.editor_focus == 1 && self.code && key.modifiers.is_empty() => { self.expansion.insert_str("\t"); }
                    KeyCode::Tab | KeyCode::BackTab => self.next_editor_field(key.code == KeyCode::BackTab || key.modifiers.contains(KeyModifiers::SHIFT)),
                    KeyCode::Enter if self.editor_focus == 1 && self.code => {
                        let cursor = self.expansion.cursor();
                        let (row, column) = self.expansion.selection_range().map(|range| range.0).unwrap_or((cursor.0, cursor.1));
                        let indent: String = self.expansion.lines()[row].chars().take(column).take_while(|c| matches!(c, ' ' | '\t')).collect();
                        self.expansion.insert_str(format!("\n{indent}"));
                    }
                    KeyCode::Enter if self.editor_focus == 0 => self.editor_focus = 1,
                    _ if self.editor_focus == 0 => self.abbreviation_input(Event::Key(key)),
                    _ if self.editor_focus == 2 => Self::single_input(&mut self.title, Event::Key(key)),
					_ if self.rich_preview=>(),
                    _ => { self.expansion.input(Event::Key(key)); }
                },
				Screen::Image=>match key.code{KeyCode::Esc=>self.screen=Screen::Edit,KeyCode::Tab|KeyCode::BackTab|KeyCode::F(2)=>{let backwards=key.code==KeyCode::BackTab||key.modifiers.contains(KeyModifiers::SHIFT);self.image_focus=if backwards{(self.image_focus+3)%4}else{(self.image_focus+1)%4};},KeyCode::Enter if self.image_focus==3=>self.image()?,_=>match self.image_focus{0=>Self::single_input(&mut self.image_source,Event::Key(key)),1=>Self::single_input(&mut self.image_alt,Event::Key(key)),2=>Self::single_input(&mut self.image_title,Event::Key(key)),_=>Self::single_input(&mut self.image_width,Event::Key(key))}},
                Screen::NewFile => match key.code { KeyCode::Enter => self.save()?, KeyCode::Esc => self.apply(Destination::Files)?, _ => Self::single_input(&mut self.name, Event::Key(key)) },
                Screen::Settings => match key.code { KeyCode::Esc => self.leave(Destination::Browse)?, KeyCode::Tab | KeyCode::BackTab => self.editor_focus = 1 - self.editor_focus, _ if self.editor_focus == 0 => Self::single_input(&mut self.url, Event::Key(key)), _ => Self::single_input(&mut self.prefix, Event::Key(key)) },
                Screen::Confirm | Screen::Move => (),
            }
        } else if let Event::Paste(text) = event {
            match self.screen {
				Screen::Image=>match self.image_focus{0=>Self::single_input(&mut self.image_source,Event::Paste(text)),1=>Self::single_input(&mut self.image_alt,Event::Paste(text)),2=>Self::single_input(&mut self.image_title,Event::Paste(text)),_=>Self::single_input(&mut self.image_width,Event::Paste(text))},
				Screen::Edit if self.editor_focus == 1&&!self.rich_preview => { self.expansion.insert_str(text.replace("\r\n", "\n").replace('\r', "\n")); }
                Screen::Edit if self.editor_focus == 2 => Self::single_input(&mut self.title, Event::Paste(text)),
                Screen::Edit => self.abbreviation_input(Event::Paste(text)),
                Screen::Settings if self.editor_focus == 0 => Self::single_input(&mut self.url, Event::Paste(text)),
                Screen::Settings => Self::single_input(&mut self.prefix, Event::Paste(text)),
                Screen::NewFile => Self::single_input(&mut self.name, Event::Paste(text)),
                Screen::Files if self.global_search_focused => { Self::single_input(&mut self.global_search, Event::Paste(text)); self.rebuild_global_hits(); }
                Screen::Browse if self.search_focused => { Self::single_input(&mut self.search, Event::Paste(text)); self.snippets_state.select(Some(0)); }
                _ => (),
            }
        } else if let Event::Mouse(mouse) = event {
            let position = Position::new(mouse.column, mouse.row);
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                if self.screen == Screen::Confirm {
                    if let Some(index) = self.confirm_buttons.iter().position(|area| area.contains(position)) { self.confirm(index)?; }
                    return Ok(());
                }
                if self.screen == Screen::Move {
                    if self.list_area.contains(position) {
                        let index = usize::from(mouse.row.saturating_sub(self.list_area.y+1)) + self.move_state.offset();
                        if index < self.move_choices.len() { self.move_state.select(Some(index)); self.choose_move()?; }
                    }
                    return Ok(());
                }
				if self.screen==Screen::Files&&!self.global_active()&&self.merge_button.contains(position){return self.request_merge();}
                if self.screen == Screen::Browse && let Some(index) = self.bulk_buttons.iter().position(|area|area.contains(position)) {
                    return if index == 0 { self.request_move() } else { self.request_delete() };
                }
                if self.screen == Screen::Trash {
                    if let Some(index) = self.trash_buttons.iter().position(|area| area.contains(position)) { return self.trash_request(if index == 0 { "restore" } else { "purge" }); }
                    if self.list_area.contains(position) { let index = usize::from(mouse.row.saturating_sub(self.list_area.y + 1)) + self.trash_state.offset(); if index < self.trash_rows.len() { self.trash_state.select(Some(index)); } return Ok(()); }
                }
                if let Some(index) = self.toolbar.iter().position(|area| area.contains(position)) { return self.toolbar_action(index); }
				if self.save_area.contains(position) { return if self.screen==Screen::Image{self.image()}else{self.save()}; }
				if self.cancel_area.contains(position) {if self.screen==Screen::Image{self.screen=Screen::Edit;return Ok(());}return self.leave(if self.screen == Screen::NewFile || self.screen == Screen::Edit && self.global_edit { Destination::Files } else { Destination::Browse }); }
                if let Some(index) = self.field_areas.iter().position(|area| area.contains(position)) {
					if self.screen == Screen::Browse { self.search_focused = true; }else if self.screen == Screen::Files { self.global_search_focused = true; }else if self.screen==Screen::Image{self.image_focus=index;} else { self.editor_focus = index; }
                }
                if self.list_area.contains(position) {
                    let row = usize::from(mouse.row.saturating_sub(self.list_area.y + 1));
                    if self.screen == Screen::Files {
                        if self.global_active() {
                            let index = row + self.global_state.offset();
                            if index < self.global_hits.len() { self.global_state.select(Some(index)); self.global_search_focused = false; }
                        } else {
                            let index = row + self.file_state.offset();
                            if index <= self.files.len() { self.file_state.select(Some(index)); self.open_selected_file()?; }
                        }
                    } else if self.screen == Screen::Browse {
                        let index = row + self.snippets_state.offset();
                        if index < self.filtered().len() { self.snippets_state.select(Some(index)); self.search_focused = false; self.select_row(mouse.modifiers.contains(KeyModifiers::SHIFT))?; }
                    }
                }
            } else if matches!(mouse.kind, MouseEventKind::ScrollDown | MouseEventKind::ScrollUp) {
                if matches!(self.screen, Screen::Files | Screen::Browse) { self.move_selection(mouse.kind == MouseEventKind::ScrollDown); }
                else if self.screen == Screen::Edit && self.editor_focus == 1 { self.expansion.input(Event::Mouse(mouse)); }
            }
        }
        Ok(())
    }

    fn border(title: impl Into<Line<'static>>, focused: bool) -> Block<'static> { Block::default().borders(Borders::ALL).title(title).border_style(Style::default().fg(if focused { Color::Cyan } else { Color::DarkGray })) }
    fn button(frame: &mut Frame, area: Rect, title: &str, enabled: bool) {
        frame.render_widget(Paragraph::new(title.to_owned()).centered().block(Self::border("", false)).style(Style::default().fg(if enabled { Color::Cyan } else { Color::DarkGray })), area);
    }
    pub fn refresh(&mut self) {
        if self.screen == Screen::Trash { let _ = self.load_trash(); }
        else if self.screen == Screen::Files { let _ = self.reload_files(); }
        else if self.screen == Screen::Browse && let Some(file) = &self.file {
            match self.store.open(&file.name) {
                Ok(current) => { if typerelay_client::database::Database::open(&self.store.directory).and_then(|db|db.editable(&current.id)).is_err() { self.selected_ids.clear(); self.selection_anchor = None; } self.selected_ids.retain(|id|current.ids.contains(id)); if self.selection_anchor.as_ref().is_some_and(|id|!current.ids.contains(id)) { self.selection_anchor = None; } self.file = Some(current); }
                Err(_) => { self.file = None; let _ = self.apply(Destination::Files); }
            }
        }
    }
    fn sync_status(&self) -> String {
        std::fs::read_to_string(self.settings.config_dir().join("sync/status")).unwrap_or_default()
    }
    pub fn draw(&mut self, frame: &mut Frame) {
        self.toolbar.clear(); self.trash_buttons.clear(); self.bulk_buttons.clear(); self.field_areas.clear(); self.list_area = Rect::default(); self.save_area = Rect::default(); self.cancel_area = Rect::default(); self.merge_button = Rect::default();
        let area = frame.area();
        if let Some(dialog)=&mut self.template_dialog {dialog.draw(frame,area);return;}
        if area.width < 60 || area.height < 20 { frame.render_widget(Paragraph::new("TypeRelay — resize terminal to at least 60 × 20. Ctrl+Q exits."), area); return; }
        let rows = Layout::vertical([Constraint::Length(2), Constraint::Length(if area.width < 75 { 6 } else { 3 }), Constraint::Min(8), Constraint::Length(3)]).split(area);
        let title = if self.effective_screen() == Screen::Files { "TypeRelay  /  Snippet editor".into() } else { self.file.as_ref().map(|file| format!("TypeRelay  /  {}", file.name)).unwrap_or("TypeRelay  /  Snippet editor".into()) };
        frame.render_widget(Paragraph::new(title).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)), rows[0]);
        let widths = [14, 9, 9, 13, 20, 10];
        self.toolbar = if area.width < 75 {
            let bands = Layout::vertical([Constraint::Length(3), Constraint::Length(3)]).split(rows[1]);
            bands.iter().enumerate().flat_map(|(row, area)| Layout::horizontal(widths[row * 3..row * 3 + 3].iter().map(|width| Constraint::Length(*width)).chain(std::iter::once(Constraint::Min(0)))).split(*area)[..3].to_vec()).collect()
        } else { Layout::horizontal(widths.map(Constraint::Length).into_iter().chain(std::iter::once(Constraint::Min(0)))).split(rows[1])[..6].to_vec() };
        for (index, title) in ["F1 Libraries", "F2 Add", "F5 Sync", "F6 Settings", "F3 Move to Trash", "F7 Trash"].iter().enumerate() { Self::button(frame, self.toolbar[index], title, !matches!(index, 1 | 4) || (self.screen == Screen::Browse && (index != 4 || self.selected().is_some()))); }
        let body = rows[2];
        match self.effective_screen() {
            Screen::Trash => {
                let parts = Layout::vertical([Constraint::Min(5), Constraint::Length(3)]).split(body);
                self.list_area = parts[0];
                let items = self.trash_rows.iter().map(|row| ListItem::new(format!("{} · {}", row["name"].as_str().unwrap_or("Item"), row["type"].as_str().unwrap_or("")))).collect::<Vec<_>>();
                frame.render_stateful_widget(List::new(items).block(Self::border("Trash · 30 days · Esc returns", true)).highlight_style(Style::default().bg(Color::DarkGray)), parts[0], &mut self.trash_state);
                self.trash_buttons = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).split(parts[1]).to_vec();
                Self::button(frame, self.trash_buttons[0], "R Restore", !self.trash_rows.is_empty());
                Self::button(frame, self.trash_buttons[1], &format!("E Empty ({})", self.trash_rows.iter().filter(|row|row["can_purge"] == true).count()), self.trash_rows.iter().any(|row|row["can_purge"] == true));
            }
            Screen::Files => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Min(3)]).split(body);
                self.global_search.set_block(Self::border("Search trigger or expansion  /", self.global_search_focused));
                frame.render_widget(&self.global_search, parts[0]); self.field_areas.push(parts[0]);
                if self.global_active() {
                    let columns = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)]).split(parts[1]);
                    self.list_area = columns[0];
                    let items = self.global_hits.iter().map(|hit| {
                        let file = &self.files[hit.file_index];
                        ListItem::new(format!("{} · {}", file.name, file.entries[hit.entry_index].label()))
                    }).collect::<Vec<_>>();
                    frame.render_stateful_widget(List::new(items).block(Self::border(format!("{} snippets — Enter to edit", self.global_hits.len()), !self.global_search_focused)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), columns[0], &mut self.global_state);
                    let preview = self.selected_global().map(|hit| self.files[hit.file_index].entries[hit.entry_index].replace.clone()).unwrap_or("No matching snippets.".into());
                    frame.render_widget(Paragraph::new(preview).scroll((0, self.preview_x)).block(Self::border("Preview · ←/→ scroll · F10 Fill/Copy", false)), columns[1]);
                } else {
                    let rows = Layout::vertical([Constraint::Min(3), Constraint::Length(3)]).split(parts[1]);
                    let items = std::iter::once(ListItem::new("+ New library")).chain(self.files.iter().map(|file| ListItem::new(self.library_label(file)))).collect::<Vec<_>>();
                    self.list_area = rows[0];
                    frame.render_stateful_widget(List::new(items).block(Self::border("Choose a library", !self.global_search_focused)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), rows[0], &mut self.file_state);
                    self.merge_button = rows[1];
                    Self::button(frame, rows[1], "M Merge selected library", self.file_state.selected().unwrap_or(0) > 0);
                }
            }
            Screen::Move => {
                self.list_area = body;
				let items=self.move_choices.iter().map(|library|ListItem::new(if self.move_from==Screen::Files{format!("{} · {} snippets · {}",library["merge_sync"].as_str().unwrap_or("Local only"),library["merge_count"].as_u64().unwrap_or(0),library["name"].as_str().unwrap_or("Library"))}else{format!("{} · {}",if library["shared"]==true{"Shared"}else{"Personal"},library["name"].as_str().unwrap_or("Library"))})).collect::<Vec<_>>();let title=if self.move_from==Screen::Files{"Merge destination · Enter selects · Esc cancels"}else{"Destination · Enter selects · Esc cancels"};frame.render_stateful_widget(List::new(items).block(Self::border(title,true)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "),body,&mut self.move_state);
            }
            Screen::Browse => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Length(3), Constraint::Min(3)]).split(body);
                if self.selected_ids.is_empty() { frame.render_widget(Paragraph::new("Space selects · Ctrl+A all · Ctrl+D clear · F8 Move"), parts[1]); }
                else {
                    let actions = Layout::horizontal([Constraint::Min(12), Constraint::Length(14), Constraint::Length(14)]).split(parts[1]);
                    frame.render_widget(Paragraph::new(format!("{} selected", self.selected_ids.len())), actions[0]);
                    self.bulk_buttons = vec![actions[1], actions[2]];
                    Self::button(frame, actions[1], "F8 Move", true); Self::button(frame, actions[2], "F3 Trash", true);
                }
                self.search.set_block(Self::border("Search trigger or expansion  /", self.search_focused));
                frame.render_widget(&self.search, parts[0]); self.field_areas.push(parts[0]);
                let columns = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)]).split(parts[2]);
                self.list_area = columns[0];
                let filtered = self.filtered();
                let entries = self.file.as_ref().map(|file| file.entries.as_slice()).unwrap_or(&[]);
                let items = filtered.iter().map(|index| ListItem::new(format!("[{}] {}", if self.selected_ids.contains(&self.file.as_ref().unwrap().ids[*index]) { "x" } else { " " }, entries[*index].label()))).collect::<Vec<_>>();
                frame.render_stateful_widget(List::new(items).block(Self::border(format!("{} snippets — Enter to edit", filtered.len()), !self.search_focused)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), columns[0], &mut self.snippets_state);
                let preview = self.selected().map(|index| self.file.as_ref().unwrap().entries[index].replace.clone()).unwrap_or("No matching snippets. F2 adds a snippet.".into());
                frame.render_widget(Paragraph::new(preview).scroll((0, self.preview_x)).block(Self::border("Preview · ←/→ scroll · F10 Fill/Copy · F11 Variables", false)), columns[1]);
            }
			Screen::Image=>{let parts=Layout::vertical([Constraint::Length(3),Constraint::Length(3),Constraint::Length(3),Constraint::Length(3),Constraint::Min(2),Constraint::Length(3)]).split(body);self.image_source.set_block(Self::border("Local path or HTTP/HTTPS URL",self.image_focus==0));self.image_alt.set_block(Self::border("Alt text",self.image_focus==1));self.image_title.set_block(Self::border("Title",self.image_focus==2));self.image_width.set_block(Self::border("Display width (32–2048)",self.image_focus==3));frame.render_widget(&self.image_source,parts[0]);frame.render_widget(&self.image_alt,parts[1]);frame.render_widget(&self.image_title,parts[2]);frame.render_widget(&self.image_width,parts[3]);frame.render_widget(Paragraph::new("PNG, JPEG, WebP, and GIF · 5 MiB input · remote images are cached for offline insertion"),parts[4]);self.field_areas.extend([parts[0],parts[1],parts[2],parts[3]]);self.form_buttons(frame,parts[5]);}
            Screen::Edit => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Length(3), Constraint::Min(3), Constraint::Length(0), Constraint::Length(2), Constraint::Length(3)]).split(body);
                let metadata = Layout::horizontal([Constraint::Percentage(80), Constraint::Percentage(20)]).split(parts[0]);
                let title_area = metadata[0];
                frame.render_widget(Paragraph::new(if self.rich{"Rich · F9"}else if self.code { "Code · F9 toggles" } else { "Text · F9 toggles" }).style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)).block(Self::border("Type", false)), metadata[1]);
                let trigger_row = Layout::horizontal([Constraint::Length(5), Constraint::Length(1), Constraint::Min(1)]).split(parts[1]);
                frame.render_widget(Paragraph::new(self.settings.settings.trigger_prefix.clone()).centered().block(Self::border("", false)).style(Style::default().fg(Color::Gray)), trigger_row[0]);
                self.trigger.set_block(Self::border("Abbreviation (optional)", self.editor_focus == 0));
                self.expansion.set_block(Self::border(if self.rich{"Rich Markdown · F12 Preview · F11 Variables"}else if self.code { "Code · Tab inserts tab · F2 / Ctrl+Tab exit · Shift+Tab back" } else { "Text · F11 Variables · Tab next field" }, self.editor_focus == 1));
                self.title.set_block(Self::border("Title (optional)", self.editor_focus == 2));
                frame.render_widget(&self.title, title_area);
				frame.render_widget(&self.trigger, trigger_row[2]);if self.rich&&self.rich_preview{if let Some(image)=&self.rich_image{let preview=Layout::horizontal([Constraint::Percentage(65),Constraint::Percentage(35)]).split(parts[2]);frame.render_widget(Paragraph::new(tui_markdown::from_str(&Self::value(&self.expansion))).wrap(Wrap{trim:false}).block(Self::border("Rich preview · F12 source",false)),preview[0]);frame.render_widget(ratatui_image::Image::new(image),preview[1]);}else{frame.render_widget(Paragraph::new(tui_markdown::from_str(&Self::value(&self.expansion))).wrap(Wrap{trim:false}).block(Self::border("Rich preview · F12 source",false)),parts[2]);}}else{frame.render_widget(&self.expansion, parts[2]);}
                self.field_areas.extend([trigger_row[2], parts[2], title_area]);
                let destination = self.move_destination.as_ref().and_then(|id| self.move_choices.iter().find(|library|library["_id"] == *id)).and_then(|library|library["name"].as_str()).unwrap_or("Current library");
                frame.render_widget(Paragraph::new(format!("Library: {destination} · Ctrl+M / F8 destination · F9 Type · F10 Fill/Copy · F11 Variables · F12 Preview")), parts[4]);
                self.form_buttons(frame, parts[5]);
            }
            Screen::NewFile => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Min(3), Constraint::Length(3)]).split(body);
                self.name.set_block(Self::border("New library name", true)); frame.render_widget(&self.name, parts[0]);
                frame.render_widget(Paragraph::new("Creates a local-only library. F4 moves a selected library to Trash."), parts[1]);
                self.field_areas.push(parts[0]); self.form_buttons(frame, parts[2]);
            }
            Screen::Settings => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Length(3), Constraint::Min(2), Constraint::Length(3)]).split(body);
                self.url.set_block(Self::border("URL to sync with", self.editor_focus == 0));
                self.prefix.set_block(Self::border("Trigger prefix · e.g. , or ;", self.editor_focus == 1));
                frame.render_widget(&self.url, parts[0]); frame.render_widget(&self.prefix, parts[1]);
                frame.render_widget(Paragraph::new("Tab switches fields. The prefix is local to this machine.\nConnect: typerelay connect --server URL · Disconnect: typerelay disconnect · F5 syncs."), parts[2]);
                self.field_areas.extend([parts[0], parts[1]]); self.form_buttons(frame, parts[3]);
            }
            Screen::Confirm => (),
        }
        frame.render_widget(Paragraph::new(format!("{}\n{} · Ctrl+S Save · Esc Back · Ctrl+Q Quit", self.status, self.sync_status())).style(Style::default().fg(if self.error { Color::Red } else { Color::Gray })).wrap(Wrap { trim: false }), rows[3]);
        if self.screen == Screen::Confirm {
            let dialog = Rect::new(area.x + (area.width - 56) / 2, area.y + (area.height - 7) / 2, 56, 7);
            frame.render_widget(Clear, dialog);
			let prompt=if let Some((source,destination,count))=&self.pending_merge{let db=typerelay_client::database::Database::open(&self.store.directory);let source_name=db.as_ref().ok().and_then(|db|db.library(source).ok()).and_then(|library|library["name"].as_str().map(str::to_owned)).unwrap_or_else(||"source".into());let destination_name=db.as_ref().ok().and_then(|db|db.library(destination).ok()).and_then(|library|library["name"].as_str().map(str::to_owned)).unwrap_or_else(||"destination".into());format!("Merge {count} snippets from {source_name} into {destination_name}?\nDestination sharing applies. Source moves to Trash.")}else if let Some((_, destination, items)) = &self.pending_batch {
                if let Some(id) = destination {
                    let name = self.move_choices.iter().find(|library|library["_id"] == *id).and_then(|library|library["name"].as_str()).unwrap_or("destination");
                    format!("Move {} snippets to {name}?\nDestination sharing permissions apply.", items.len())
                } else { format!("Move {} selected snippets to Trash?", items.len()) }
            } else if let Some((action, targets)) = &self.pending_trash {
                if action == "purge" { format!("Permanently remove {} eligible Trash items?\\nThis cannot be undone.", targets.len()) } else if action == "restore" { format!("Restore '{}'?", targets[0]["name"].as_str().unwrap_or("item")) } else { "Move this library and its active snippets to Trash?".into() }
            } else if let Some(index) = self.pending_delete { format!("Move abbreviation to Trash '{}'?", self.file.as_ref().unwrap().entries[index].trigger) } else { "Unsaved changes\nSave your draft before leaving?".into() };
            frame.render_widget(Paragraph::new(prompt).wrap(Wrap { trim: false }).block(Self::border("Confirm", true)), dialog);
            let buttons = Rect::new(dialog.x + 2, dialog.y + 3, dialog.width - 4, 3);
            self.confirm_buttons = Layout::horizontal([Constraint::Ratio(1, 3), Constraint::Ratio(1, 3), Constraint::Ratio(1, 3)]).split(buttons).to_vec();
			if self.pending_delete.is_some()||self.pending_trash.is_some()||self.pending_batch.is_some()||self.pending_merge.is_some(){self.confirm_buttons=vec![self.confirm_buttons[2],self.confirm_buttons[0]];}
			let titles:&[&str]=if self.pending_merge.is_some(){&["M Merge","Esc Cancel"]}else if let Some((_,destination,_))=&self.pending_batch{if destination.is_some(){&["M Move","Esc Cancel"]}else{&["D Trash","Esc Cancel"]}}else if let Some((action,_))=&self.pending_trash{if action=="restore"{&["R Restore","Esc Cancel"]}else if action=="purge"{&["E Empty","Esc Cancel"]}else{&["D Trash","Esc Cancel"]}}else if self.pending_delete.is_some(){&["D Trash","Esc Cancel"]}else{&["S Save","D Discard","Esc Cancel"]};
            for (index, title) in titles.iter().enumerate() { Self::button(frame, self.confirm_buttons[index], title, true); }
        }
    }
    fn form_buttons(&mut self, frame: &mut Frame, area: Rect) {
        let parts = Layout::horizontal([Constraint::Length(16), Constraint::Min(0), Constraint::Length(18)]).split(area);
        self.cancel_area = parts[0]; self.save_area = parts[2];
        Self::button(frame, parts[0], "Esc Cancel", true); Self::button(frame, parts[2], "Ctrl+S Save", true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::KeyEvent;
    #[test]
    fn code_enter_retains_exact_leading_whitespace() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        app.screen = Screen::Edit; app.editor_focus = 1;
        for prefix in ["\t", "    ", "\t  ", ""] {
            for code in [false, true] {
                app.code = code; app.expansion = App::text(&format!("{prefix}example"));
                app.expansion.move_cursor(ratatui_textarea::CursorMove::End);
                Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
                assert_eq!(App::value(&app.expansion), format!("{prefix}example\n{}", if code { prefix } else { "" }));
            }
        }
    }
    #[test]
    fn editor_layout_and_navigation_reach_every_field_in_both_modes() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        app.file = Some(app.store.create("Layout").unwrap()); app.screen = Screen::Browse;
        app.edit(true).unwrap();
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30)).unwrap();
        for code in [false, true] {
            app.code = code;
            terminal.draw(|frame| app.draw(frame)).unwrap();
            assert!(app.field_areas[2].y < app.field_areas[0].y);
            assert_eq!(app.field_areas.len(), 3);
            let before = app.field_areas.clone(); let focus = app.editor_focus;
            app.error = true;
            Fixture::key(&mut app, KeyCode::F(9), KeyModifiers::NONE);
            terminal.draw(|frame| app.draw(frame)).unwrap();
            assert_eq!(before, app.field_areas); assert_eq!(focus, app.editor_focus);
            assert!(app.status.starts_with("Type:")); assert!(!app.error);
            Fixture::key(&mut app, KeyCode::F(9), KeyModifiers::NONE);
            let order = [2, 0, 1];
            app.editor_focus = order[0];
            for expected in order.into_iter().cycle().skip(1).take(3) {
                let key = if code && app.editor_focus == 1 { KeyCode::F(2) } else { KeyCode::Tab };
                Fixture::key(&mut app, key, KeyModifiers::NONE);
                assert_eq!(app.editor_focus, expected);
            }
            for expected in order.into_iter().rev() {
                Fixture::key(&mut app, KeyCode::BackTab, KeyModifiers::SHIFT);
                assert_eq!(app.editor_focus, expected);
            }
            for field in 0..3 {
                let area = app.field_areas[field];
                app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: area.x + 1, row: area.y + 1, modifiers: KeyModifiers::NONE }));
                assert_eq!(app.editor_focus, field);
            }
        }
    }
    #[test]
    fn code_editor_keeps_tabs_and_metadata_without_abbreviation() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        app.file = Some(app.store.create("Code").unwrap()); app.screen = Screen::Browse;
        Fixture::key(&mut app, KeyCode::F(2), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::F(9), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::F(2), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        app.handle(Event::Paste("  {{ λ }}  \n\n".into()));
        assert_eq!(app.editor_focus, 1);
        Fixture::key(&mut app, KeyCode::F(2), KeyModifiers::NONE);
        app.handle(Event::Paste("Code title".into()));
        Fixture::key(&mut app, KeyCode::F(2), KeyModifiers::NONE);
        app.language = "Rust".into();
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        let entry = &app.store.open("Code").unwrap().entries[0];
        assert_eq!(entry.replace, "\t  {{ λ }}  \n\n");
        assert_eq!(entry.title, "Code title"); assert_eq!(entry.language, "Rust"); assert_eq!(entry.kind, "code"); assert!(entry.trigger.is_empty());
    }
	#[test]
	fn rich_source_preview_and_image_dialog_persist_assets(){let temp=tempfile::tempdir().unwrap();let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();use base64::Engine as _;let path=temp.path().join("dot.png");std::fs::write(&path,png).unwrap();let mut app=Fixture::app(temp.path());app.file=Some(app.store.create("Rich").unwrap());app.screen=Screen::Browse;app.edit(true).unwrap();for _ in 0..2{Fixture::key(&mut app,KeyCode::F(9),KeyModifiers::NONE);}assert!(app.rich);app.expansion=App::text("# Heading\n\n| A | B |\n|---|---|\n| C | D |");Fixture::key(&mut app,KeyCode::F(12),KeyModifiers::NONE);assert!(app.rich_preview);let mut terminal=ratatui::Terminal::new(ratatui::backend::TestBackend::new(100,30)).unwrap();terminal.draw(|frame|app.draw(frame)).unwrap();Fixture::key(&mut app,KeyCode::F(12),KeyModifiers::NONE);app.image_source=App::text(path.to_str().unwrap());app.image_alt=App::text("Dot");app.image_title=App::text("Tiny");app.image_width=App::text("64");app.screen=Screen::Image;app.image().unwrap();assert!(App::value(&app.expansion).contains("typerelay-asset:"));app.save().unwrap();let entry=&app.store.open("Rich").unwrap().entries[0];assert_eq!(entry.kind,"rich_text");assert_eq!(entry.value()["content"]["assets"].as_array().unwrap().len(),1);}
    #[test]
    fn settings_prefix_changes_form_but_saved_trigger_is_bare() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        app.file = Some(app.store.create("mine").unwrap()); app.screen = Screen::Browse;
        Fixture::key(&mut app, KeyCode::F(6), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Delete, KeyModifiers::NONE);
        app.handle(Event::Paste(";".into()));
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!(app.settings.settings.trigger_prefix, ";");
        Fixture::key(&mut app, KeyCode::F(2), KeyModifiers::NONE);
        app.handle(Event::Paste(";new".into()));
        Fixture::key(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        app.handle(Event::Paste("New expansion".into()));
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!(app.store.open("mine").unwrap().entries[0].trigger, "new");
    }
    struct Fixture;
    impl Fixture {
        fn app(directory: &std::path::Path) -> App { App::new(EditorStore::new(directory.join("snippets")).unwrap(), SettingsStore::open(directory.join("settings.yml")).unwrap()).unwrap() }
        fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) { app.handle(Event::Key(KeyEvent::new(code, modifiers))); }
    }
    #[test]
    fn global_search_renders_counts_results_preview_and_returns_after_save() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let alpha = app.store.create("Alpha").unwrap();
        let alpha = app.store.save(&alpha, None, Match { trigger: "shared-alpha".into(), replace: "Alpha preview".into(), ..Match::default() }).unwrap();
        app.store.save(&alpha, None, Match { trigger: "other".into(), replace: "Other text".into(), ..Match::default() }).unwrap();
        let beta = app.store.create("Beta").unwrap();
        app.store.save(&beta, None, Match { trigger: "shared-beta".into(), replace: "Beta preview".into(), ..Match::default() }).unwrap();
        app.store.create("Empty").unwrap();
        app.refresh();
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30)).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let screen = terminal.backend().buffer().content().iter().map(|cell| cell.symbol()).collect::<String>();
        assert!(screen.contains("Search trigger or expansion"));
        assert!(screen.contains("+ New library"));
        assert!(screen.contains("Alpha (2)")); assert!(screen.contains("Beta (1)")); assert!(screen.contains("Empty (0)"));
        Fixture::key(&mut app, KeyCode::Char('/'), KeyModifiers::NONE);
        app.handle(Event::Paste("shared".into()));
        assert_eq!(app.global_hits.len(), 2);
        Fixture::key(&mut app, KeyCode::Down, KeyModifiers::NONE);
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let screen = terminal.backend().buffer().content().iter().map(|cell| cell.symbol()).collect::<String>();
        assert!(screen.contains("Alpha · shared-alpha")); assert!(screen.contains("Beta · shared-beta")); assert!(screen.contains("Beta preview"));
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Files);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Edit);
        assert_eq!(app.file.as_ref().unwrap().name, "Beta");
        app.expansion = App::text("Beta updated");
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!(app.screen, Screen::Files);
        assert_eq!(App::value(&app.global_search), "shared");
        assert_eq!(app.selected_global().unwrap().library_id, beta.id);
        assert_eq!(app.store.open("Beta").unwrap().entries[0].replace, "Beta updated");
    }
    #[test]
    fn global_search_refreshes_stable_selection_and_active_counts() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let first = app.store.create("First").unwrap();
        app.store.save(&first, None, Match { trigger: "find-first".into(), replace: "One".into(), ..Match::default() }).unwrap();
        let second = app.store.create("Second").unwrap();
        app.store.save(&second, None, Match { trigger: "find-second".into(), replace: "Two".into(), ..Match::default() }).unwrap();
        app.refresh();
        Fixture::key(&mut app, KeyCode::Char('/'), KeyModifiers::NONE);
        app.handle(Event::Paste("find".into()));
        Fixture::key(&mut app, KeyCode::Down, KeyModifiers::NONE);
        let selected = app.selected_global().unwrap().snippet_id.clone();
        let latest_first = app.store.open("First").unwrap();
        app.store.delete(&latest_first, 0).unwrap();
        app.refresh();
        assert_eq!(app.global_hits.len(), 1);
        assert_eq!(app.selected_global().unwrap().snippet_id, selected);
        assert_eq!(app.library_label(&app.files[0]), "First (0)");
        let latest_second = app.store.open("Second").unwrap();
        app.store.delete(&latest_second, 0).unwrap();
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Files);
        assert!(app.error);
        assert!(app.status.contains("removed"));
        app.refresh();
        assert!(app.global_hits.is_empty()); assert_eq!(app.global_state.selected(), None);
        assert_eq!(app.library_label(&app.files[1]), "Second (0)");
        let db = typerelay_client::database::Database::open(&app.store.directory).unwrap();
        db.queue(&serde_json::json!({"kind":"merge_local","source":first.id})).unwrap();
        assert_eq!(app.library_label(&app.files[0]), "First (0) · Merge pending");
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30)).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let screen = terminal.backend().buffer().content().iter().map(|cell| cell.symbol()).collect::<String>();
        assert!(screen.contains("No matching snippets."));
    }
    #[test]
    fn global_search_mouse_focus_and_escape_preserve_library_search() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("Mine").unwrap();
        app.store.save(&file, None, Match { trigger: "needle".into(), replace: "Preview".into(), ..Match::default() }).unwrap();
        app.refresh();
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30)).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let field = app.field_areas[0];
        app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: field.x + 1, row: field.y + 1, modifiers: KeyModifiers::NONE }));
        assert!(app.global_search_focused);
        app.handle(Event::Paste("needle".into()));
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let list = app.list_area;
        app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: list.x + 2, row: list.y + 1, modifiers: KeyModifiers::NONE }));
        assert_eq!(app.global_state.selected(), Some(0)); assert!(!app.global_search_focused);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Edit);
        Fixture::key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Files);
        assert_eq!(App::value(&app.global_search), "needle");
        app.global_search = App::text(""); app.rebuild_global_hits();
        app.file_state.select(Some(1));
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Browse);
        assert_eq!(App::value(&app.search), "");
        Fixture::key(&mut app, KeyCode::Char('/'), KeyModifiers::NONE);
        app.handle(Event::Paste("needle".into()));
        assert_eq!(App::value(&app.search), "needle");
        assert_eq!(App::value(&app.global_search), "");
    }
    #[test]
    fn global_search_f10_opens_the_existing_fill_dialog() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("Templates").unwrap();
        app.store.save(&file, None, Match { trigger: "welcome".into(), replace: "Hello {{name}}".into(), kind: "template".into(), ..Match::default() }).unwrap();
        app.refresh();
        Fixture::key(&mut app, KeyCode::Char('/'), KeyModifiers::NONE);
        app.handle(Event::Paste("welcome".into()));
        Fixture::key(&mut app, KeyCode::F(10), KeyModifiers::NONE);
        assert!(app.template_dialog.is_some());
        assert_eq!(app.fill_base.as_ref().unwrap().0, "Templates");
        assert_eq!(app.screen, Screen::Files);
    }
    #[test]
    fn delete_selected_filtered_snippet_requires_confirmation_and_keeps_file() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("mine").unwrap();
        let file = app.store.save(&file, None, Match { variables: Default::default(), trigger: "first".into(), replace: "Keep\nthis".into(), ..Match::default() }).unwrap();
        app.file = Some(app.store.save(&file, None, Match { variables: Default::default(), trigger: "second".into(), replace: "Remove".into(), ..Match::default() }).unwrap());
        app.screen = Screen::Browse;
        app.search = App::text("second");
        app.snippets_state.select(Some(0));
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Confirm);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.store.open("mine").unwrap().entries.len(), 2);
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        assert_eq!(app.file.as_ref().unwrap().entries[0].trigger, "first");
        assert!(app.filtered().is_empty());
        app.search = App::text("");
        app.snippets_state.select(Some(0));
        Fixture::key(&mut app, KeyCode::Delete, KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        assert!(app.store.open("mine").unwrap().entries.is_empty());
        assert_eq!(app.screen, Screen::Browse);
    }
    #[test]
    fn delete_conflict_keeps_confirmation_and_search_delete_edits_query() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("mine").unwrap();
        app.file = Some(app.store.save(&file, None, Match { variables: Default::default(), trigger: "first".into(), replace: "Keep".into(), ..Match::default() }).unwrap());
        app.screen = Screen::Browse; app.search_focused = true;
        Fixture::key(&mut app, KeyCode::Delete, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Browse);
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        let concurrent = app.store.open("mine").unwrap(); app.store.delete(&concurrent, 0).unwrap();
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Confirm);
        assert!(app.error);
        assert_eq!(app.file.as_ref().unwrap().entries.len(), 1);
        Fixture::key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Browse);
    }
    #[test]
    fn mouse_delete_and_readonly_permissions() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("mine").unwrap();
        app.file = Some(app.store.save(&file, None, Match { variables: Default::default(), trigger: "first".into(), replace: "Keep".into(), ..Match::default() }).unwrap());
        app.screen = Screen::Browse;
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let button = app.toolbar[4];
        app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: button.x + 1, row: button.y + 1, modifiers: KeyModifiers::NONE }));
        assert_eq!(app.screen, Screen::Confirm);
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let button = app.confirm_buttons[0];
        app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: button.x + 1, row: button.y + 1, modifiers: KeyModifiers::NONE }));
        assert!(app.file.as_ref().unwrap().entries.is_empty());
        app.file = Some(app.store.save(app.file.as_ref().unwrap(), None, Match { variables: Default::default(), trigger: "shared".into(), replace: "Read only".into(), ..Match::default() }).unwrap());
        let db = typerelay_client::database::Database::open(&app.store.directory).unwrap();
        db.connection.execute("UPDATE libraries SET data=json_set(data,'$.permissions.edit',json('false'))", []).unwrap();
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Browse);
        assert!(app.status.contains("read-only"));
        assert_eq!(app.store.open("mine").unwrap().entries.len(), 1);
    }
    #[test]
    fn trash_page_restores_and_empties_with_confirmation() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("Local").unwrap();
        app.file = Some(app.store.save(&file, None, Match { variables: Default::default(), trigger: "hello".into(), replace: "Hello".into(), ..Match::default() }).unwrap());
        app.screen = Screen::Browse;
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::F(7), KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Trash);
        assert_eq!(app.trash_rows.len(), 1);
        Fixture::key(&mut app, KeyCode::Char('r'), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.trash_rows.len(), 1);
        Fixture::key(&mut app, KeyCode::Char('r'), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('r'), KeyModifiers::NONE);
        assert!(app.trash_rows.is_empty());
        app.file = Some(app.store.open("Local").unwrap()); app.screen = Screen::Browse;
        Fixture::key(&mut app, KeyCode::F(4), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::F(7), KeyModifiers::NONE);
        assert_eq!(app.trash_rows[0]["type"], "library");
        Fixture::key(&mut app, KeyCode::Char('e'), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('e'), KeyModifiers::NONE);
        assert!(app.trash_rows.is_empty());
        assert!(app.store.files().unwrap().is_empty());
    }
    #[test]
    fn create_add_search_edit_and_dirty_confirmation() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        app.handle(Event::Paste("sales".into())); Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::F(2), KeyModifiers::NONE);
        assert_eq!(App::value(&app.trigger), "");
        app.handle(Event::Paste(";hello".into()));
        assert_eq!(App::value(&app.trigger), "hello");
        assert_eq!(app.draft().trigger, "hello");
        Fixture::key(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        app.handle(Event::Paste("Hello\nworld\n".into()));
        Fixture::key(&mut app, KeyCode::Esc, KeyModifiers::NONE); assert_eq!(app.screen, Screen::Confirm);
        Fixture::key(&mut app, KeyCode::Esc, KeyModifiers::NONE); assert_eq!(app.screen, Screen::Edit);
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL); assert_eq!(app.screen, Screen::Browse);
        Fixture::key(&mut app, KeyCode::Char('/'), KeyModifiers::NONE); app.handle(Event::Paste("WORLD".into())); assert_eq!(app.filtered(), vec![0]);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE); Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(App::value(&app.trigger), "hello");
        assert!(!app.dirty());
        app.expansion.insert_str("changed"); Fixture::key(&mut app, KeyCode::F(1), KeyModifiers::NONE); Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Files); assert_eq!(app.store.open("sales").unwrap().entries[0].replace, "Hello\nworld\n");
    }
    #[test]
    fn disconnected_sync_settings_and_failed_save_keep_draft() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        Fixture::key(&mut app, KeyCode::F(5), KeyModifiers::NONE); assert!(app.status.contains("Connect first"));
        Fixture::key(&mut app, KeyCode::F(6), KeyModifiers::NONE); app.handle(Event::Paste("https://example.invalid/sync".into()));
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL); assert!(temp.path().join("settings.yml").exists());
        app.file = Some(app.store.create("mine").unwrap()); app.screen = Screen::Browse; app.edit(true).unwrap();
        app.trigger = App::text("invalid space"); app.expansion = App::text("My draft");
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL); assert_eq!(app.screen, Screen::Edit); assert!(app.error); assert_eq!(app.draft().replace, "My draft");
    }
    #[test]
    fn sync_settings_show_connect_and_disconnect_commands() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        Fixture::key(&mut app, KeyCode::F(6), KeyModifiers::NONE);
        let backend = ratatui::backend::TestBackend::new(100, 30); let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let screen = terminal.backend().buffer().content().iter().map(|cell|cell.symbol()).collect::<String>();
        assert!(screen.contains("typerelay connect --server URL")); assert!(screen.contains("typerelay disconnect"));
    }
    #[test]
    fn renders_and_mouse_opens_new_file() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let backend = ratatui::backend::TestBackend::new(100, 30); let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: app.list_area.x + 2, row: app.list_area.y + 1, modifiers: KeyModifiers::NONE }));
        assert_eq!(app.screen, Screen::NewFile);
    }
    #[test]
    fn selection_range_filtered_all_move_and_edit_destination() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let db = typerelay_client::database::Database::open(&app.store.directory).unwrap();
        let source = db.import("Source", "matches: [{trigger: a, replace: Alpha}, {trigger: b, replace: Beta}, {trigger: c, replace: Gamma}]").unwrap();
        db.create("Destination").unwrap();
        app.file = Some(source); app.screen = Screen::Browse; app.snippets_state.select(Some(0));
        Fixture::key(&mut app, KeyCode::Char(' '), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Down, KeyModifiers::SHIFT);
        assert_eq!(app.selected_ids.len(), 2);
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::CONTROL);
        assert!(app.selected_ids.is_empty());
        app.search = App::text("Beta"); app.snippets_state.select(Some(0));
        Fixture::key(&mut app, KeyCode::Char('a'), KeyModifiers::CONTROL);
        assert_eq!(app.selected_ids.len(), 1);
        Fixture::key(&mut app, KeyCode::F(8), KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Move);
        Fixture::key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.screen, Screen::Browse);
        assert_eq!(app.selected_ids.len(), 1);
        Fixture::key(&mut app, KeyCode::F(8), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('m'), KeyModifiers::NONE);
        assert_eq!(db.editor("Destination").unwrap().entries[0].trigger, "b");
        assert!(app.selected_ids.is_empty());
        app.search = App::text(""); app.snippets_state.select(Some(0));
        app.edit(false).unwrap();
        app.expansion = App::text("Edited in form");
        Fixture::key(&mut app, KeyCode::Char('m'), KeyModifiers::CONTROL);
        assert_eq!(app.screen, Screen::Move);
        Fixture::key(&mut app, KeyCode::Down, KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(app.move_destination.is_some());
        assert!(app.dirty());
        Fixture::key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!(app.screen, Screen::Browse);
        assert!(db.editor("Destination").unwrap().entries.iter().any(|entry|entry.trigger == "a" && entry.replace == "Edited in form"));
        assert_eq!(db.snapshot().unwrap().len(), 3);
    }
	#[test]
	fn library_picker_merges_selected_source_and_supports_confirmation_cancel() {
		let temp=tempfile::tempdir().unwrap();let mut app=Fixture::app(temp.path());let db=typerelay_client::database::Database::open(&app.store.directory).unwrap();db.import("Destination","matches: [{trigger: first, replace: First}]").unwrap();let source=db.import("Recovered","matches: [{trigger: second, replace: Second}]").unwrap();app.refresh();let index=app.files.iter().position(|file|file.name=="Recovered").unwrap()+1;app.file_state.select(Some(index));Fixture::key(&mut app,KeyCode::Char('m'),KeyModifiers::NONE);assert_eq!(app.screen,Screen::Move);Fixture::key(&mut app,KeyCode::Enter,KeyModifiers::NONE);assert_eq!(app.screen,Screen::Confirm);Fixture::key(&mut app,KeyCode::Esc,KeyModifiers::NONE);assert_eq!(app.screen,Screen::Files);app.file_state.select(Some(index));let mut terminal=ratatui::Terminal::new(ratatui::backend::TestBackend::new(100,30)).unwrap();terminal.draw(|frame|app.draw(frame)).unwrap();app.handle(Event::Mouse(ratatui::crossterm::event::MouseEvent{kind:MouseEventKind::Down(MouseButton::Left),column:app.merge_button.x+1,row:app.merge_button.y+1,modifiers:KeyModifiers::NONE}));assert_eq!(app.screen,Screen::Move);Fixture::key(&mut app,KeyCode::Enter,KeyModifiers::NONE);Fixture::key(&mut app,KeyCode::Char('m'),KeyModifiers::NONE);assert_eq!(app.screen,Screen::Files);assert_eq!(app.status,"Libraries merged");assert_eq!(db.library(&source.id).unwrap()["state"],"trashed");assert_eq!(db.editor("Destination").unwrap().entries.len(),2);
	}
    #[test]
    fn bulk_trash_uses_selection_and_readonly_cannot_select() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let db = typerelay_client::database::Database::open(&app.store.directory).unwrap();
        let source = db.import("Source", "matches: [{trigger: a, replace: A}, {trigger: b, replace: B}]").unwrap();
        app.file = Some(source); app.screen = Screen::Browse; app.snippets_state.select(Some(0));
        Fixture::key(&mut app, KeyCode::Char('a'), KeyModifiers::CONTROL);
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.selected_ids.len(), 2);
        assert_eq!(db.snapshot().unwrap().len(), 2);
        Fixture::key(&mut app, KeyCode::F(3), KeyModifiers::NONE);
        Fixture::key(&mut app, KeyCode::Char('d'), KeyModifiers::NONE);
        assert_eq!(db.trash().unwrap().len(), 2);
        db.trash_action(&db.trash().unwrap()[0], "restore").unwrap();
        db.connection.execute("UPDATE libraries SET data=json_set(data,'$.permissions.edit',json('false'))", []).unwrap();
        app.refresh();
        Fixture::key(&mut app, KeyCode::Char(' '), KeyModifiers::NONE);
        assert!(app.selected_ids.is_empty());
        assert!(app.status.contains("read-only"));
    }

}
