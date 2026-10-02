use anyhow::{Result,ensure};
use typerelay_client::{config::Match,native_ai::NativeAi};
fn main()->Result<()> {
    let root=std::path::PathBuf::from(std::env::args().nth(1).expect("Pass the config directory with an enabled model"));
    for(action,text,kind,must_change)in [
        ("create","I would like to write a message to cancel a meeting.","plain_text",true),
        ("rewrite","cant make the meeting today sorry lets reschedule","plain_text",true),
        ("rewrite","The meeting is cancelled. Thank you for your understanding.","plain_text",false),
        ("rewrite","Hi {{name}}, cant make the meeting today sorry lets reschedule.","template",true)
    ] {
        let original=Match{replace:text.into(),kind:kind.into(),title:"Cancellation".into(),trigger:"cancel-meeting".into(),..Default::default()};let start=std::time::Instant::now();let result=NativeAi::author(&root,&original,action,&uuid::Uuid::new_v4().to_string())?;
        if must_change{ensure!(result.replace!=text,"Model echoed the input for {action}");}if action=="create"{ensure!(result.replace.to_lowercase().contains("cancel")&&!result.replace.to_lowercase().contains("like to write"),"Create returned a request instead of a message");}
        ensure!(result.title==original.title&&result.trigger==original.trigger&&result.variables==original.variables,"Metadata changed");println!("{}",serde_json::json!({"action":action,"seconds":start.elapsed().as_secs_f64(),"unchanged":result.replace==text,"text":result.replace}));
    }
    Ok(())
}
