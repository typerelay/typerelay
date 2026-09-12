use std::io::{self, BufRead, Write};
use typerelay_client::bridge::{Bridge, Request};

fn main() -> anyhow::Result<()> {
    for line in io::stdin().lock().lines() {
        let result = line.map_err(anyhow::Error::from).and_then(|line| serde_json::from_str::<Request>(&line).map_err(Into::into)).and_then(Bridge::execute);
        let output = match result { Ok(response) => serde_json::to_value(response)?, Err(error) => serde_json::json!({"error": format!("{error:#}")}) };
        println!("{output}");
        io::stdout().flush()?;
    }
    Ok(())
}
