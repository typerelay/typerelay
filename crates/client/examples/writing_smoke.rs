use anyhow::{Result,ensure};
use typerelay_client::{config::Match,native_ai::NativeAi};
fn main()->Result<()> {
    let root=std::path::PathBuf::from(std::env::args().nth(1).expect("Pass the config directory with an enabled model"));
    for(action,text,kind,must_change)in [
        ("refine","I need a canned response for proposing a later meeting date.","plain_text",true),
        ("refine","I would like to write a message to cancel a meeting.","plain_text",true),
        ("refine","cant make the meeting today sorry lets reschedule","plain_text",true),
        ("refine","The meeting is cancelled. Thank you for your understanding.","plain_text",false),
        ("refine","Hi {{name}}, cant make the meeting today sorry lets reschedule.","template",true)
    ] {
        let original=Match{replace:text.into(),kind:kind.into(),title:"Cancellation".into(),trigger:"cancel-meeting".into(),..Default::default()};let start=std::time::Instant::now();let result=NativeAi::author(&root,&original,action,&uuid::Uuid::new_v4().to_string())?;
        if must_change{ensure!(result.replace!=text,"Model echoed the input for {action}");}if text.contains("write a message to cancel"){ensure!(result.replace.to_lowercase().contains("cancel")&&!result.replace.to_lowercase().contains("like to write"),"Create returned a request instead of a message");}
        ensure!(!result.replace.to_lowercase().contains("i need a canned response"),"Model restated request");
        ensure!(result.title==original.title&&result.trigger==original.trigger&&result.variables==original.variables,"Metadata changed");println!("{}",serde_json::json!({"action":action,"seconds":start.elapsed().as_secs_f64(),"unchanged":result.replace==text,"text":result.replace}));
    }
    Ok(())
}
