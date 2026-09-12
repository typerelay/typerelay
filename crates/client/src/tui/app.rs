use anyhow::{Result, Context};
use ratatui::{Frame, layout::{Constraint, Layout, Rect, Position}, style::{Color, Modifier, Style}, text::Line, widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap}};
use ratatui::crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui_textarea::TextArea;
use typerelay_core::Engine;
use typerelay_client::{config::Match, editor::{EditorStore, OpenFile}, settings::SettingsStore};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen { Files, Browse, Edit, NewFile, Settings, Confirm }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Destination { Files, Browse, Settings, Quit }

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
        Ok(Self { store, settings, screen: Screen::Files, files, file_state, snippets_state: ListState::default(), file: None, search: TextArea::default(), search_focused: false, trigger: TextArea::default(), expansion: TextArea::default(), name: TextArea::default(), url: TextArea::default(), editor_focus: 0, editing: None, original_entry: None, original_url: String::new(), prefix: TextArea::default(), original_prefix: String::new(), pending: None, confirm_from: Screen::Files, status: "Choose a file, or create a new one".into(), error: false, quit: false, toolbar: Vec::new(), list_area: Rect::default(), field_areas: Vec::new(), save_area: Rect::default(), cancel_area: Rect::default(), confirm_buttons: Vec::new() })
    }
    fn text(value: &str) -> TextArea<'static> { TextArea::new(value.split('\n').map(str::to_owned).collect()) }
    fn value(field: &TextArea<'_>) -> String { field.lines().join("\n") }
    fn draft(&self) -> Match { Match { trigger: Self::value(&self.trigger), replace: Self::value(&self.expansion) } }
    fn effective_screen(&self) -> Screen { if self.screen == Screen::Confirm { self.confirm_from } else { self.screen } }
    fn dirty(&self) -> bool {
        match self.effective_screen() {
            Screen::Edit => self.original_entry.as_ref() != Some(&self.draft()),
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
        self.file = Some(self.store.open(name)?);
        self.search = TextArea::default();
        self.search_focused = false;
        self.snippets_state.select(Some(0));
        self.screen = Screen::Browse;
        self.message("Enter: edit selected snippet · /: search", false);
        Ok(())
    }
    fn edit(&mut self, new: bool) -> Result<()> {
        self.settings.reload()?;
        let file = self.file.as_ref().context("Choose a file first")?;
        typerelay_client::sync::Sync::editable(&typerelay_client::editor::Paths::config_dir()?, &self.store.directory, &file.name)?;
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
                let saved = { typerelay_client::sync::Sync::editable(&typerelay_client::editor::Paths::config_dir()?, &self.store.directory, &file.name)?; self.store.save(file, self.editing, entry.clone())? };
                self.file = Some(saved);
                self.original_entry = Some(entry);
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
    fn confirm(&mut self, choice: usize) -> Result<()> {
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
            1 => { self.message("Choose a snippet file first", false); Ok(()) },
            2 => { typerelay_client::sync::Sync::trigger(&typerelay_client::editor::Paths::config_dir()?)?; self.message("Sync requested. Use typerelay sync for immediate CLI status.", false); Ok(()) },
            3 => self.leave(Destination::Settings),
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
            if self.screen == Screen::Confirm {
                return match key.code { KeyCode::Char('s') => self.confirm(0), KeyCode::Char('d') => self.confirm(1), KeyCode::Char('c') | KeyCode::Esc | KeyCode::Enter => self.confirm(2), _ => Ok(()) };
            }
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                match key.code {
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
                _ => (),
            }
            match self.screen {
                Screen::Files => match key.code {
                    KeyCode::Down | KeyCode::Char('j') => self.move_selection(true),
                    KeyCode::Up | KeyCode::Char('k') => self.move_selection(false),
                    KeyCode::Enter => self.open_selected_file()?,
                    KeyCode::Esc => self.leave(Destination::Quit)?,
                    _ => (),
                },
                Screen::Browse => match key.code {
                    KeyCode::Down => self.move_selection(true), KeyCode::Up => self.move_selection(false),
                    KeyCode::Esc if self.search_focused => self.search_focused = false,
                    KeyCode::Esc => self.leave(Destination::Files)?,
                    KeyCode::Enter if self.search_focused => self.search_focused = false,
                    KeyCode::Enter => self.edit(false)?,
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
                Screen::Confirm => (),
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
                        if index < self.filtered().len() { self.snippets_state.select(Some(index)); self.search_focused = false; }
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
    fn sync_status(&self) -> String {
        typerelay_client::editor::Paths::config_dir().ok().and_then(|root| std::fs::read_to_string(root.join("sync/status")).ok()).unwrap_or_default()
    }
    pub fn draw(&mut self, frame: &mut Frame) {
        self.toolbar.clear(); self.field_areas.clear(); self.list_area = Rect::default(); self.save_area = Rect::default(); self.cancel_area = Rect::default();
        let area = frame.area();
        if area.width < 60 || area.height < 20 { frame.render_widget(Paragraph::new("TypeRelay — resize terminal to at least 60 × 20. Ctrl+Q exits."), area); return; }
        let rows = Layout::vertical([Constraint::Length(2), Constraint::Length(3), Constraint::Min(8), Constraint::Length(3)]).split(area);
        let title = self.file.as_ref().map(|file| format!("TypeRelay  /  {}", file.name)).unwrap_or("TypeRelay  /  Snippet editor".into());
        frame.render_widget(Paragraph::new(title).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)), rows[0]);
        self.toolbar = Layout::horizontal([Constraint::Length(14), Constraint::Length(14), Constraint::Length(16), Constraint::Length(18), Constraint::Min(0)]).split(rows[1])[..4].to_vec();
        for (index, title) in ["F1 Files", "F2 Add", "F5 Sync", "F6 Settings"].iter().enumerate() { Self::button(frame, self.toolbar[index], title, index != 1 || self.screen == Screen::Browse); }
        let body = rows[2];
        match self.effective_screen() {
            Screen::Files => {
                let items = std::iter::once(ListItem::new("+ New file")).chain(self.files.iter().map(|name| ListItem::new(typerelay_client::sync::Sync::label(&typerelay_client::editor::Paths::config_dir().unwrap_or_default(), &self.store.directory, name)))).collect::<Vec<_>>();
                self.list_area = body;
                frame.render_stateful_widget(List::new(items).block(Self::border("Choose a snippet file", true)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), body, &mut self.file_state);
            }
            Screen::Browse => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Min(3)]).split(body);
                self.search.set_block(Self::border("Search trigger or expansion  /", self.search_focused));
                frame.render_widget(&self.search, parts[0]); self.field_areas.push(parts[0]);
                let columns = Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)]).split(parts[1]);
                self.list_area = columns[0];
                let filtered = self.filtered();
                let entries = self.file.as_ref().map(|file| file.entries.as_slice()).unwrap_or(&[]);
                let items = filtered.iter().map(|index| ListItem::new(entries[*index].trigger.clone())).collect::<Vec<_>>();
                frame.render_stateful_widget(List::new(items).block(Self::border(format!("{} snippets — Enter to edit", filtered.len()), !self.search_focused)).highlight_style(Style::default().bg(Color::DarkGray)).highlight_symbol("› "), columns[0], &mut self.snippets_state);
                let preview = self.selected().map(|index| self.file.as_ref().unwrap().entries[index].replace.clone()).unwrap_or("No matching snippets. F2 adds a snippet.".into());
                frame.render_widget(Paragraph::new(preview).wrap(Wrap { trim: false }).block(Self::border("Expansion preview", false)), columns[1]);
            }
            Screen::Edit => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Min(3), Constraint::Length(3)]).split(body);
                let trigger_row = Layout::horizontal([Constraint::Length(5), Constraint::Length(1), Constraint::Min(1)]).split(parts[0]);
                frame.render_widget(Paragraph::new(self.settings.settings.trigger_prefix.clone()).centered().block(Self::border("", false)).style(Style::default().fg(Color::Gray)), trigger_row[0]);
                self.trigger.set_block(Self::border("Abbreviation", self.editor_focus == 0));
                self.expansion.set_block(Self::border("Expansion · Enter = newline · Ctrl+T = tab", self.editor_focus == 1));
                frame.render_widget(&self.trigger, trigger_row[2]); frame.render_widget(&self.expansion, parts[1]); self.field_areas.extend([parts[0], parts[1]]);
                self.form_buttons(frame, parts[2]);
            }
            Screen::NewFile => {
                let parts = Layout::vertical([Constraint::Length(3), Constraint::Min(3), Constraint::Length(3)]).split(body);
                self.name.set_block(Self::border("New filename (.yml or .yaml)", true)); frame.render_widget(&self.name, parts[0]);
                frame.render_widget(Paragraph::new("Creates an empty snippet file. Existing files are never overwritten."), parts[1]);
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
            frame.render_widget(Paragraph::new("Unsaved changes\nSave your draft before leaving?").block(Self::border("Confirm", true)), dialog);
            let buttons = Rect::new(dialog.x + 2, dialog.y + 3, dialog.width - 4, 3);
            self.confirm_buttons = Layout::horizontal([Constraint::Ratio(1, 3), Constraint::Ratio(1, 3), Constraint::Ratio(1, 3)]).split(buttons).to_vec();
            for (index, title) in ["S Save", "D Discard", "Esc Cancel"].iter().enumerate() { Self::button(frame, self.confirm_buttons[index], title, true); }
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
        assert_eq!(app.store.open("mine.yml").unwrap().entries[0].trigger, "new");
    }
    struct Fixture;
    impl Fixture {
        fn app(directory: &std::path::Path) -> App { App::new(EditorStore::new(directory.join("snippets")).unwrap(), SettingsStore::open(directory.join("settings.yml")).unwrap()).unwrap() }
        fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) { app.handle(Event::Key(KeyEvent::new(code, modifiers))); }
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
        assert_eq!(app.screen, Screen::Files); assert_eq!(app.store.open("sales.yml").unwrap().entries[0].replace, "Hello\nworld\n");
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
}
