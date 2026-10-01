//! One authenticated, per-user worker; keyboard handling never links to this process.
use anyhow::{Context, Result, ensure};
use llama_cpp_2::{context::params::LlamaContextParams, llama_backend::LlamaBackend, llama_batch::LlamaBatch, model::{LlamaModel, params::LlamaModelParams}, sampling::LlamaSampler};
use serde_json::{Value, json};
use std::{collections::HashMap, fs, net::{TcpListener, TcpStream}, num::NonZeroU32, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}}, time::{Duration, Instant}};
use typerelay_client::{editor::Paths, native_ai::{NativeAi, Endpoint}};

struct Runtime { backend: Option<LlamaBackend>, model: Option<(String, LlamaModel)>, used: Instant, gpu: bool }
impl Runtime {
    fn infer(&mut self, root: &std::path::Path, request: &Value, cancelled: &Arc<AtomicBool>) -> Result<Value> {
        let id = NativeAi::settings(root)?.model.context("AI is disabled")?;
        ensure!(!cancelled.load(Ordering::Relaxed), "Cancelled");
        if self.backend.is_none() { let backend=LlamaBackend::init()?;self.backend=Some(backend); }
        let backend=self.backend.as_ref().unwrap();
        if self.model.as_ref().is_none_or(|(loaded,_)| loaded != &id) {
            self.model = None; let catalog = NativeAi::model(&id)?; let path = NativeAi::path(root, &catalog)?; NativeAi::verify(&path, &catalog, cancelled)?;
            let cancellation = cancelled.clone(); let load_started = Instant::now(); let parameters = LlamaModelParams::default().with_n_gpu_layers(if self.gpu {99} else {0}).with_progress_callback(move |_| !cancellation.load(Ordering::Relaxed) && load_started.elapsed() < Duration::from_secs(120));
            let model = LlamaModel::load_from_file(backend, &path, &parameters).or_else(|error| { if cancelled.load(Ordering::Relaxed) { return Err(error); } let cancellation = cancelled.clone(); LlamaModel::load_from_file(backend, &path, &LlamaModelParams::default().with_n_gpu_layers(0).with_progress_callback(move |_| !cancellation.load(Ordering::Relaxed) && load_started.elapsed() < Duration::from_secs(120))) })?;
            self.model = Some((id.clone(), model));
        }
        self.used = Instant::now(); let model = &self.model.as_ref().unwrap().1; let vocab = model.vocab(); let prompt = request["prompt"].as_str().context("Missing prompt")?; ensure!(prompt.len() <= 22000, "Prompt too long");
        // Pinned text-only templates, explicitly excluding thinking channels.
        let prompt = if id.starts_with("qwen") { format!("<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n\n") } else { format!("<bos><|turn>user\n{prompt}<turn|>\n<|turn>model\n") };
        let tokens = vocab.tokenize(prompt.as_bytes(), false, true); ensure!(tokens.len() < 6000, "Draft exceeds model context");
        let threads = std::thread::available_parallelism().map(|count|count.get().saturating_sub(2).clamp(1,4)).unwrap_or(2) as i32;
        let parameters = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(8192)).with_n_batch(256).with_n_threads(threads).with_n_threads_batch(threads);
        let mut context = model.new_context(backend, parameters)?; let started = Instant::now(); let mut batch = LlamaBatch::new(256,1);
        for (chunk_index, chunk) in tokens.chunks(256).enumerate() {
            ensure!(!cancelled.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(120), "AI cancelled or timed out"); batch.clear();
            for (index, token) in chunk.iter().enumerate() { let position = chunk_index * 256 + index; batch.add(*token, position as i32, &[0], position == tokens.len()-1)?; } context.decode(&mut batch)?;
        }
        let grammar = if request["kind"] == "search" { "root ::= \"{\" ws \"\\\"intent\\\"\" ws \":\" ws (\"\\\"literal\\\"\" | \"\\\"descriptive\\\"\") ws \",\" ws \"\\\"terms\\\"\" ws \":\" ws \"[\" ws (string (ws \",\" ws string)*)? ws \"]\" ws \"}\"\n" } else { "root ::= \"{\" ws \"\\\"text\\\"\" ws \":\" ws string ws \"}\"\n" };
        let grammar = format!("{grammar}string ::= \"\\\"\" ([^\"\\\\\\x00-\\x1F] | \"\\\\\" ([\"\\\\/bfnrt] | \"u\" [0-9a-fA-F]{{4}}))* \"\\\"\"\nws ::= [ \\t\\n\\r]*\n");
        let mut sampler = LlamaSampler::chain_simple([LlamaSampler::grammar(model, &grammar, "root")?, LlamaSampler::greedy()]); let mut bytes = Vec::new(); let limit = if request["kind"] == "search" { 256 } else { 1800 };
        for offset in 0..limit {
            ensure!(!cancelled.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(120), "AI cancelled or timed out");
            let token = sampler.sample(&context, -1); if vocab.is_eog(token) { break; }
            bytes.extend(vocab.token_to_piece(token, false, None)); if let Ok(value) = serde_json::from_slice::<Value>(&bytes) { self.used = Instant::now(); return Ok(value); }
            batch.clear(); batch.add(token, (tokens.len()+offset) as i32, &[0], true)?; context.decode(&mut batch)?;
        }
        self.used = Instant::now(); Ok(serde_json::from_slice(&bytes)?)
    }
}

struct Worker { root: PathBuf, token: String, runtime: Mutex<Runtime>, jobs: Mutex<HashMap<String, Arc<AtomicBool>>>, cancelled: Mutex<HashMap<String, Instant>>, download: Mutex<Option<String>>, error: Mutex<Option<String>>, authors: AtomicUsize, clients: AtomicUsize, mutation: Mutex<()> }
impl Worker {
    fn run(root: PathBuf, gpu: bool) -> Result<()> {
        let directory = NativeAi::directory(&root)?; let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(directory.join("worker.lock"))?;
        if fs2::FileExt::try_lock_exclusive(&lock).is_err() { return Ok(()); }
        let listener = TcpListener::bind("127.0.0.1:0")?; let token = uuid::Uuid::new_v4().to_string();
        let worker = Arc::new(Self { root, token: token.clone(), runtime: Mutex::new(Runtime { backend:None, model: None, used: Instant::now(), gpu }), jobs: Mutex::new(HashMap::new()), cancelled: Mutex::new(HashMap::new()), download: Mutex::new(None), error: Mutex::new(None), authors: AtomicUsize::new(0), clients: AtomicUsize::new(0), mutation: Mutex::new(()) });
        Paths::atomic_write(&directory.join("endpoint.json"), &serde_json::to_vec(&Endpoint { address: listener.local_addr()?, token })?, false)?;
        let idle = worker.clone(); std::thread::spawn(move || loop { std::thread::sleep(Duration::from_secs(1)); if let Ok(mut runtime) = idle.runtime.try_lock() { if runtime.used.elapsed() >= Duration::from_secs(300) { runtime.model = None; } } });
        for stream in listener.incoming() { let stream = stream?; if worker.clients.fetch_add(1, Ordering::SeqCst) >= 16 { worker.clients.fetch_sub(1, Ordering::SeqCst); continue; } let worker = worker.clone(); std::thread::spawn(move || { let _ = worker.serve(stream); worker.clients.fetch_sub(1, Ordering::SeqCst); }); } Ok(())
    }
    fn serve(&self, mut stream: TcpStream) -> Result<()> { stream.set_read_timeout(Some(Duration::from_secs(5)))?; stream.set_write_timeout(Some(Duration::from_secs(5)))?; let request = NativeAi::read(&mut stream)?; ensure!(request["token"] == self.token, "Unauthorized"); let response = match self.handle(request) { Ok(value) => json!({"value":value}), Err(error) => json!({"error":error.to_string()}) }; NativeAi::write(&mut stream, &response) }
    fn handle(&self, request: Value) -> Result<Value> {
        let operation = request["op"].as_str().unwrap_or("");
        if operation == "shutdown" { for flag in self.jobs.lock().unwrap().values() { flag.store(true, Ordering::Relaxed); } std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(100)); std::process::exit(0); }); return Ok(Value::Null); }
        if operation == "status" { let settings = NativeAi::settings(&self.root)?; let mut models = Vec::new(); for model in NativeAi::catalog() { let path = NativeAi::path(&self.root, &model)?; let mut row = serde_json::to_value(&model)?; row["installed"] = json!(path.is_file()); row["downloaded"] = json!(fs::metadata(path.with_extension("partial")).map(|value|value.len()).unwrap_or(0)); models.push(row); } let loaded=self.runtime.try_lock().ok().and_then(|runtime|runtime.model.as_ref().map(|(id,_)|id.clone())); return Ok(json!({"enabled":settings.enabled.unwrap_or(settings.model.is_some()),"model":settings.model,"models":models,"download":*self.download.lock().unwrap(),"error":*self.error.lock().unwrap(),"loaded":loaded,"busy":self.runtime.try_lock().is_err()})); }
        if operation == "cancel" { if let Some(id)=request["id"].as_str() { ensure!(id.len()<=80,"Invalid request ID");let mut cancelled=self.cancelled.lock().unwrap();cancelled.retain(|_,time|time.elapsed()<Duration::from_secs(180));ensure!(cancelled.len()<1024,"Too many cancellations");cancelled.insert(id.to_owned(),Instant::now()); } let jobs = self.jobs.lock().unwrap(); if let Some(id) = request["id"].as_str() { if let Some(flag) = jobs.get(id) { flag.store(true, Ordering::Relaxed); } } return Ok(Value::Null); }
        if ["enable","disable","remove"].contains(&operation) {
            let _mutation = self.mutation.lock().unwrap(); ensure!(self.download.lock().unwrap().is_none(), "Cancel the download first");
            for flag in self.jobs.lock().unwrap().values() { flag.store(true, Ordering::Relaxed); }
            let mut runtime = self.runtime.lock().unwrap(); runtime.model = None;
            if operation == "enable" && request["model"].is_null() { NativeAi::save(&self.root, NativeAi::settings(&self.root)?.model, true)?; return Ok(Value::Null); }
            if operation == "disable" { NativeAi::save(&self.root, None, false)?; } else { let model = NativeAi::model(request["model"].as_str().context("Choose a model")?)?; let path = NativeAi::path(&self.root, &model)?;
                if operation == "enable" { NativeAi::verify(&path, &model, &AtomicBool::new(false))?; NativeAi::save(&self.root, Some(model.id), true)?; } else { if NativeAi::settings(&self.root)?.model.as_deref() == Some(&model.id) { NativeAi::save(&self.root,None, false)?; } for path in [path.clone(),path.with_extension("partial")] { if path.exists() { fs::remove_file(path)?; } } }
            } return Ok(Value::Null);
        }
        let id = request["id"].as_str().context("Missing request ID")?.to_owned(); ensure!(id.len() <= 80, "Invalid request ID"); let flag = Arc::new(AtomicBool::new(self.cancelled.lock().unwrap().remove(&id).is_some()));
        { let mut jobs = self.jobs.lock().unwrap(); ensure!(!jobs.contains_key(&id), "Duplicate request"); jobs.insert(id.clone(), flag.clone()); }
        let result = (|| -> Result<Value> {
            ensure!(!flag.load(Ordering::Relaxed),"Cancelled");
            if operation == "download" {
                let _mutation = self.mutation.lock().unwrap(); let model = NativeAi::model(request["model"].as_str().context("Choose a model")?)?;
                { let mut download = self.download.lock().unwrap(); ensure!(download.is_none(), "Download already active"); *download = Some(id.clone()); } *self.error.lock().unwrap() = None;
                let result = NativeAi::download(&self.root, &model, &flag).and_then(|_| { ensure!(!flag.load(Ordering::Relaxed), "Cancelled"); NativeAi::save(&self.root, Some(model.id.clone()), true) });
                *self.download.lock().unwrap() = None; if let Err(error) = &result { *self.error.lock().unwrap() = Some(error.to_string()); } result?; return Ok(Value::Null);
            }
            ensure!(operation == "infer", "Unknown AI operation");
            if request["kind"] == "search" { ensure!(self.authors.load(Ordering::SeqCst) == 0, "Authoring busy"); let mut runtime = self.runtime.try_lock().map_err(|_|anyhow::anyhow!("AI busy"))?; runtime.infer(&self.root, &request, &flag) } else {
                self.authors.fetch_add(1, Ordering::SeqCst); let result = self.runtime.lock().unwrap().infer(&self.root, &request, &flag); self.authors.fetch_sub(1, Ordering::SeqCst); result
            }
        })(); self.jobs.lock().unwrap().remove(&id); result
    }
}
fn main() -> Result<()> { let args: Vec<_> = std::env::args_os().collect(); if args.get(1).is_some_and(|arg|arg == "--version") { println!("typerelay-ai {}", env!("TYPERELAY_VERSION")); return Ok(()); } ensure!((args.len()==3 || (args.len()==4 && args[3]=="--cpu")) && args[1]=="--root", "Usage: typerelay-ai --root <config directory> [--cpu]"); Worker::run(PathBuf::from(&args[2]), args.len()==3) }
