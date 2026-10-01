use anyhow::Result;
use typerelay_client::{database::Database,panel::Panel};
fn main()->Result<()> {
    let args:Vec<_>=std::env::args().collect();let temporary=tempfile::tempdir()?;let directory=temporary.path().join("snippets");std::fs::create_dir_all(&directory)?;
    if let Some(path)=args.get(1){if path.ends_with(".json"){let response=serde_json::from_slice(&std::fs::read(path)?)?;Database::open(&directory)?.apply(&response,None)?;}else{let source=rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;source.backup(rusqlite::MAIN_DB,directory.join("typerelay.sqlite"),None)?;}}
    else {let db=Database::open(&directory)?;for group in 0..10{let records:Vec<_>=(group*1000..(group+1)*1000).map(|index|serde_json::json!({"trigger":format!("s{index}"),"replace":format!("Missed meeting followup number {index}; contact support to reschedule.")})).collect();db.import(&format!("Benchmark{group}"),&serde_json::json!({"matches":records}).to_string())?;}}
    let queries=["missed","meeting","missed meeting","meeting missed","meeitng","reschedlue"];
    let cold=std::time::Instant::now();let rows=Panel::search(&directory,"missed meeting",None)?;println!("cold_ms={:.2} matches={}",cold.elapsed().as_secs_f64()*1000.0,rows.len());
    if args.get(1).is_some_and(|path|path.ends_with(".json")){for title in ["Helpmonks - Missed meeting","Razuna - Missed meeting"]{anyhow::ensure!(rows.iter().any(|row|row.title==title),"Missing imported snippet {title}");}println!("Imported meeting snippets verified after sync");}
    let mut times=Vec::new();for _ in 0..5{for query in queries{let now=std::time::Instant::now();let hits=Panel::search(&directory,query,None)?;Panel::personal_rows(&directory,&hits)?;times.push(now.elapsed().as_secs_f64()*1000.0);}}
    times.sort_by(f64::total_cmp);println!("warm_search_and_metadata_p95_ms={:.2}",times[times.len()*95/100]);Ok(())
}
