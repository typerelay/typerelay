use anyhow::{Result, Context};
use ratatui::{Frame, layout::{Constraint, Layout, Rect, Position}, style::{Color, Modifier, Style}, text::Line, widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap}};
use ratatui::crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui_textarea::TextArea;
use typerelay_core::Engine;
use typerelay_client::{config::Match, editor::{EditorStore, OpenFile}, settings::SettingsStore};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen { Files, Browse, Edit, NewFile, Settings, Trash, Move, Confirm }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Destination { Files, Browse, Settings, Trash, Quit }

pub struct App {
    store: EditorStore,
    settings: SettingsStore,
    pub screen: Screen,
    files: Vec<String>,
    file_state: ListState,
    snippets_state: ListState,
    file: Option<OpenFile>,
    search: TextArea<'static>,
    search_focused: bool,
    trigger: TextArea<'static>,
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
}

impl App {
    pub fn new(store: EditorStore, settings: SettingsStore) -> Result<Self> {
        let files = store.files()?;
        let mut file_state = ListState::default();
        file_state.select(Some(0));
        Ok(Self { store, settings, screen: Screen::Files, files, file_state, snippets_state: ListState::default(), file: None, search: TextArea::default(), search_focused: false, trigger: TextArea::default(), expansion: TextArea::default(), name: TextArea::default(), url: TextArea::default(), editor_focus: 0, editing: None, original_entry: None, original_url: String::new(), prefix: TextArea::default(), original_prefix: String::new(), pending: None, pending_delete: None, selected_ids: std::collections::BTreeSet::new(), selection_anchor: None, move_destination: None, move_choices: Vec::new(), move_state: ListState::default(), move_from: Screen::Browse, move_items: Vec::new(), pending_batch: None, bulk_buttons: Vec::new(), pending_trash: None, trash_rows: Vec::new(), trash_state: ListState::default(), trash_buttons: Vec::new(), confirm_from: Screen::Files, status: "Choose a file, or create a new one".into(), error: false, quit: false, toolbar: Vec::new(), list_area: Rect::default(), field_areas: Vec::new(), save_area: Rect::default(), cancel_area: Rect::default(), confirm_buttons: Vec::new() })
    }
    fn text(value: &str) -> TextArea<'static> { TextArea::new(value.split('\n').map(str::to_owned).collect()) }
    fn value(field: &TextArea<'_>) -> String { field.lines().join("\n") }
    fn draft(&self) -> Match { Match { trigger: Self::value(&self.trigger), replace: Self::value(&self.expansion) } }
    fn effective_screen(&self) -> Screen { if self.screen == Screen::Confirm { self.confirm_from } else { self.screen } }
    fn dirty(&self) -> bool {
        match self.effective_screen() {
            Screen::Edit => self.original_entry.as_ref() != Some(&self.draft()) || self.move_destination.is_some(),
            Screen::Settings => Self::value(&self.url) != self.original_url || Self::value(&self.prefix) != self.original_prefix,
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
            Destination::Files => { self.files = self.store.files()?; self.file_state.select(Some(0)); self.screen = Screen::Files; }
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
        let name = self.files.get(index - 1).context("Select a file")?;
        let next = self.store.open(name)?;
        if self.file.as_ref().is_none_or(|file| file.id != next.id) { self.selected_ids.clear(); self.selection_anchor = None; }
        self.file = Some(next);
        self.search = TextArea::default();
        self.search_focused = false;
        self.snippets_state.select(Some(0));
        self.screen = Screen::Browse;
        self.message("Enter: edit · /: search · F4: trash library · F7: Trash", false);
        Ok(())
    }
    fn edit(&mut self, new: bool) -> Result<()> {
        self.settings.reload()?;
        self.move_destination = None;
        let file = self.file.as_ref().context("Choose a file first")?;
        typerelay_client::sync::Sync::editable(self.settings.config_dir(), &self.store.directory, &file.name)?;
        self.editing = if new { None } else { Some(self.selected().context("Select a snippet")?) };
        let entry = self.editing.map(|index| file.entries[index].clone()).unwrap_or(Match { trigger: String::new(), replace: String::new() });
        self.trigger = Self::text(&entry.trigger);
        self.trigger.move_cursor(ratatui_textarea::CursorMove::End);
        self.expansion = Self::text(&entry.replace);
        self.original_entry = Some(entry);
        self.editor_focus = 0;
        self.screen = Screen::Edit;
        self.message("Tab switches fields · Enter adds a line · Ctrl+T inserts a tab · Ctrl+S saves", false);
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
                self.screen = Screen::Browse;
                let count = self.filtered().len();
                self.snippets_state.select(if count == 0 { None } else { Some(0) });
                self.message("Saved. The running engine reloads automatically.", false);
            }
            Screen::Settings => {
                self.settings.save(&Self::value(&self.url), &Self::value(&self.prefix))?;
                self.original_url = self.settings.settings.sync_url.clone();
                self.original_prefix = self.settings.settings.trigger_prefix.clone();
                self.screen = if self.file.is_some() { Screen::Browse } else { Screen::Files };
                self.message("Settings saved. Connect with typerelay connect --server URL.", false);
            }
            Screen::NewFile => {
                self.file = Some(self.store.create(Self::value(&self.name).trim())?);
                self.files = self.store.files()?;
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
    fn choose_move(&mut self) -> Result<()> {
        let destination = self.move_choices.get(self.move_state.selected().unwrap_or(0)).context("Choose a destination")?["_id"].as_str().context("Missing destination")?.to_owned();
        let source = self.file.as_ref().context("Choose a source")?.id.clone();
        if self.move_from == Screen::Edit {
            self.move_destination = if destination == source { None } else { Some(destination) };
            self.screen = Screen::Edit;
        } else {
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
        let count = if self.screen == Screen::Files { self.files.len() + 1 } else { self.filtered().len() };
        let state = if self.screen == Screen::Files { &mut self.file_state } else { &mut self.snippets_state };
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
                KeyCode::F(2) => return self.toolbar_action(1),
                KeyCode::F(5) => return self.toolbar_action(2),
                KeyCode::F(6) => return self.toolbar_action(3),
                KeyCode::F(8) => return self.request_move(),
                KeyCode::F(7) => return self.toolbar_action(5),
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
                    KeyCode::Down | KeyCode::Char('j') => self.move_selection(true),
                    KeyCode::Up | KeyCode::Char('k') => self.move_selection(false),
                    KeyCode::Enter => self.open_selected_file()?,
                    KeyCode::Esc => self.leave(Destination::Quit)?,
                    _ => (),
                },
                Screen::Browse => match key.code {
                    KeyCode::Down | KeyCode::Up if key.modifiers.contains(KeyModifiers::SHIFT) && !self.search_focused => {
                        if self.selection_anchor.is_none() { self.selection_anchor = self.selected().map(|index|self.file.as_ref().unwrap().ids[index].clone()); }
                        self.move_selection(key.code == KeyCode::Down); self.select_row(true)?;
                    }
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
                    KeyCode::Esc => self.leave(Destination::Browse)?,
                    KeyCode::Tab | KeyCode::BackTab => self.editor_focus = 1 - self.editor_focus,
                    KeyCode::Enter if self.editor_focus == 0 => self.editor_focus = 1,
                    _ if self.editor_focus == 0 => self.abbreviation_input(Event::Key(key)),
                    _ => { self.expansion.input(Event::Key(key)); }
                },
                Screen::NewFile => match key.code { KeyCode::Enter => self.save()?, KeyCode::Esc => self.apply(Destination::Files)?, _ => Self::single_input(&mut self.name, Event::Key(key)) },
                Screen::Settings => match key.code { KeyCode::Esc => self.leave(Destination::Browse)?, KeyCode::Tab | KeyCode::BackTab => self.editor_focus = 1 - self.editor_focus, _ if self.editor_focus == 0 => Self::single_input(&mut self.url, Event::Key(key)), _ => Self::single_input(&mut self.prefix, Event::Key(key)) },
                Screen::Confirm | Screen::Move => (),
            }
        } else if let Event::Paste(text) = event {
            match self.screen {
                Screen::Edit if self.editor_focus == 1 => { self.expansion.insert_str(text.replace("\r\n", "\n").replace('\r', "\n")); }
                Screen::Edit => self.abbreviation_input(Event::Paste(text)),
                Screen::Settings if self.editor_focus == 0 => Self::single_input(&mut self.url, Event::Paste(text)),
                Screen::Settings => Self::single_input(&mut self.prefix, Event::Paste(text)),
                Screen::NewFile => Self::single_input(&mut self.name, Event::Paste(text)),
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
                if self.screen == Screen::Browse && let Some(index) = self.bulk_buttons.iter().position(|area|area.contains(position)) {
                    return if index == 0 { self.request_move() } else { self.request_delete() };
                }
                if self.screen == Screen::Trash {
                    if let Some(index) = self.trash_buttons.iter().position(|area| area.contains(position)) { return self.trash_request(if index == 0 { "restore" } else { "purge" }); }
                    if self.list_area.contains(position) { let index = usize::from(mouse.row.saturating_sub(self.list_area.y + 1)) + self.trash_state.offset(); if index < self.trash_rows.len() { self.trash_state.select(Some(index)); } return Ok(()); }
                }
                if let Some(index) = self.toolbar.iter().position(|area| area.contains(position)) { return self.toolbar_action(index); }
                if self.save_area.contains(position) { return self.save(); }
                if self.cancel_area.contains(position) { return self.leave(if self.screen == Screen::NewFile { Destination::Files } else { Destination::Browse }); }
                if let Some(index) = self.field_areas.iter().position(|area| area.contains(position)) {
                    if self.screen == Screen::Browse { self.search_focused = true; } else { self.editor_focus = index; }
                }
                if self.list_area.contains(position) {
                    let row = usize::from(mouse.row.saturating_sub(self.list_area.y + 1));
                    if self.screen == Screen::Files {
                        let index = row + self.file_state.offset();
                        if index <= self.files.len() { self.file_state.select(Some(index)); self.open_selected_file()?; }
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
        else if self.screen == Screen::Files { if let Ok(files) = self.store.files() { self.files = files; } }
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
        self.toolbar.clear(); self.trash_buttons.clear(); self.bulk_buttons.clear(); self.field_areas.clear(); self.list_area = Rect::default(); self.save_area = Rect::default(); self.cancel_area = Rect::default();
        let area = frame.area();
        if area.width < 60 || area.height < 20 { frame.render_widget(Paragraph::new("TypeRelay — resize terminal to at least 60 × 20. Ctrl+Q exits."), area); return; }
        let rows = Layout::vertical([Constraint::Length(2), Constraint::Length(3), Constraint::Min(8), Constraint::Length(3)]).split(area);
        let title = self.file.as_ref().map(|file| format!("TypeRelay  /  {}", file.name)).unwrap_or("TypeRelay  /  Snippet editor".into());
        frame.render_widget(Paragraph::new(title).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)), rows[0]);
        self.toolbar = Layout::horizontal([Constraint::Length(10), Constraint::Length(9), Constraint::Length(9), Constraint::Length(12), Constraint::Length(10), Constraint::Length(10), Constraint::Min(0)]).split(rows[1])[..6].to_vec();
        for (index, title) in ["F1 Libs", "F2 Add", "F5 Sync", "F6 Settings", "F3 Trash", "F7 Trash"].iter().enumerate() { Self::button(frame, self.toolbar[index], title, !matches!(index, 1 | 4) || (self.screen == Screen::Browse && (index != 4 || self.selected().is_some()))); }
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
                let items = std::iter::once(ListItem::new("+ New library")).chain(self.files.iter().map(|name| ListItem::new(typerelay_client::sync::Sync::label(self.settings.config_dir(), &self.store.directory, name)))).collect::<Vec<_>>();
                self.list_area = body;
                frame.render_stateful_widget(List::new(items).block(Self::border("Choose a library", true)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), body, &mut self.file_state);
            }
            Screen::Move => {
                self.list_area = body;
                let items = self.move_choices.iter().map(|library| ListItem::new(format!("{} · {}", if library["shared"] == true { "Shared" } else { "Personal" }, library["name"].as_str().unwrap_or("Library")))).collect::<Vec<_>>();
                frame.render_stateful_widget(List::new(items).block(Self::border("Destination · Enter selects · Esc cancels", true)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), body, &mut self.move_state);
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
                let items = filtered.iter().map(|index| ListItem::new(format!("[{}] {}", if self.selected_ids.contains(&self.file.as_ref().unwrap().ids[*index]) { "x" } else { " " }, entries[*index].trigger))).collect::<Vec<_>>();
                frame.render_stateful_widget(List::new(items).block(Self::border(format!("{} snippets — Enter to edit", filtered.len()), !self.search_focused)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), columns[0], &mut self.snippets_state);
                let preview = self.selected().map(|index| self.file.as_ref().unwrap().entries[index].replace.clone()).unwrap_or("No matching snippets. F2 adds a snippet.".into());
                frame.render_widget(Paragraph::new(preview).wrap(Wrap { trim: false }).block(Self::border("Expansion preview", false)), columns[1]);
            }
            Screen::Edit => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Min(3), Constraint::Length(2), Constraint::Length(3)]).split(body);
                let destination = self.move_destination.as_ref().and_then(|id| self.move_choices.iter().find(|library|library["_id"] == *id)).and_then(|library|library["name"].as_str()).unwrap_or("Current library");
                frame.render_widget(Paragraph::new(format!("Library: {destination} · Ctrl+M / F8 changes destination")), parts[2]);
                let trigger_row = Layout::horizontal([Constraint::Length(5), Constraint::Length(1), Constraint::Min(1)]).split(parts[0]);
                frame.render_widget(Paragraph::new(self.settings.settings.trigger_prefix.clone()).centered().block(Self::border("", false)).style(Style::default().fg(Color::Gray)), trigger_row[0]);
                self.trigger.set_block(Self::border("Abbreviation", self.editor_focus == 0));
                self.expansion.set_block(Self::border("Expansion · Enter = newline · Ctrl+T = tab", self.editor_focus == 1));
                frame.render_widget(&self.trigger, trigger_row[2]); frame.render_widget(&self.expansion, parts[1]); self.field_areas.extend([parts[0], parts[1]]);
                self.form_buttons(frame, parts[2]);
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
                frame.render_widget(Paragraph::new("Tab switches fields. The prefix is local to this machine.\nConnect with typerelay connect --server URL. F5 requests sync."), parts[2]);
                self.field_areas.extend([parts[0], parts[1]]); self.form_buttons(frame, parts[3]);
            }
            Screen::Confirm => (),
        }
        frame.render_widget(Paragraph::new(format!("{}\n{} · Ctrl+S Save · Esc Back · Ctrl+Q Quit", self.status, self.sync_status())).style(Style::default().fg(if self.error { Color::Red } else { Color::Gray })).wrap(Wrap { trim: false }), rows[3]);
        if self.screen == Screen::Confirm {
            let dialog = Rect::new(area.x + (area.width - 56) / 2, area.y + (area.height - 7) / 2, 56, 7);
            frame.render_widget(Clear, dialog);
            let prompt = if let Some((_, destination, items)) = &self.pending_batch {
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
            if self.pending_delete.is_some() || self.pending_trash.is_some() || self.pending_batch.is_some() { self.confirm_buttons = vec![self.confirm_buttons[2], self.confirm_buttons[0]]; }
            let titles: &[&str] = if let Some((_, destination, _)) = &self.pending_batch { if destination.is_some() { &["M Move", "Esc Cancel"] } else { &["D Trash", "Esc Cancel"] } } else if let Some((action, _)) = &self.pending_trash { if action == "restore" { &["R Restore", "Esc Cancel"] } else if action == "purge" { &["E Empty", "Esc Cancel"] } else { &["D Trash", "Esc Cancel"] } } else if self.pending_delete.is_some() { &["D Trash", "Esc Cancel"] } else { &["S Save", "D Discard", "Esc Cancel"] };
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
    fn delete_selected_filtered_snippet_requires_confirmation_and_keeps_file() {
        let temp = tempfile::tempdir().unwrap(); let mut app = Fixture::app(temp.path());
        let file = app.store.create("mine").unwrap();
        let file = app.store.save(&file, None, Match { trigger: "first".into(), replace: "Keep\nthis".into() }).unwrap();
        app.file = Some(app.store.save(&file, None, Match { trigger: "second".into(), replace: "Remove".into() }).unwrap());
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
        app.file = Some(app.store.save(&file, None, Match { trigger: "first".into(), replace: "Keep".into() }).unwrap());
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
        app.file = Some(app.store.save(&file, None, Match { trigger: "first".into(), replace: "Keep".into() }).unwrap());
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
        app.file = Some(app.store.save(app.file.as_ref().unwrap(), None, Match { trigger: "shared".into(), replace: "Read only".into() }).unwrap());
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
        app.file = Some(app.store.save(&file, None, Match { trigger: "hello".into(), replace: "Hello".into() }).unwrap());
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
        app.handle(Event::Paste(",hello".into()));
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
