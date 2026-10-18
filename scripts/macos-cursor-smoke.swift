// Run with an isolated TypeRelay profile and macos-cursor-fixture.swift, from an Accessibility-approved GUI session.
// --fixtures emits JSON (valid YAML) to import into that profile; otherwise pass the fixture's test directory.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Sample {
    let name:String
    let before:String
    let after:String
    let keys:[CGKeyCode]
    static let all=[Sample(name:"short",before:"Hello ",after:", thanks!",keys:[1,4,31,15,17]),Sample(name:"long",before:"BEGIN ",after:String(repeating:"a",count:2808),keys:[37,31,45,5]),Sample(name:"large",before:"BEGIN ",after:String(repeating:"b",count:12000),keys:[37,0,15,5,14]),Sample(name:"unicode",before:"before\n😀",after:String(repeating:"e\u{301} tail\n",count:80),keys:[32,45,34,8,31,2,14]),Sample(name:"end",before:String(repeating:"a",count:12000),after:"",keys:[14,45,2]),Sample(name:"start",before:"",after:"suffix\n",keys:[1,17,0,15,17]),Sample(name:"zwj",before:"👩‍💻e\u{301}",after:"👨‍👩‍👦🇩🇪\n",keys:[6,13,38])]
}
if CommandLine.arguments.contains("--fixtures") {
    let matches=Sample.all.map{["trigger":$0.name,"type":"template","replace":$0.before+"{{cursor:here}}"+$0.after]}
    print(String(data:try! JSONSerialization.data(withJSONObject:["matches":matches],options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!);exit(0)
}
guard CommandLine.arguments.count==2 else{fatalError("Pass the fixture test directory or --fixtures")}
let root=URL(fileURLWithPath:CommandLine.arguments[1])
let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
let accessibility=AXIsProcessTrustedWithOptions(options)
let input=CGRequestPostEventAccess()
print("Native input permissions: accessibility=\(accessibility), input=\(input)");fflush(stdout)
guard input else{fatalError("Allow /usr/bin/swift Accessibility in the GUI session")}
func state()->[String:Any] {guard let data=try? Data(contentsOf:root.appendingPathComponent("fixture-state.json")),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{return [:]};return value}
func stroke(_ key:CGKeyCode){let source=CGEventSource(stateID:.hidSystemState)!;for down in [true,false]{let event=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:down)!;event.flags=[];event.post(tap:.cghidEventTap);Thread.sleep(forTimeInterval:0.012)}}
func wait(_ seconds:Double,_ condition:()->Bool)->Bool{let deadline=Date().addingTimeInterval(seconds);repeat{if condition(){return true};Thread.sleep(forTimeInterval:0.025)}while Date()<deadline;return false}
var revision=0
func reset(_ mode:String,_ initial:String="",_ caret:Int=0){revision+=1;let command:[String:Any]=["revision":revision,"mode":mode,"initial":initial,"caret":caret];try! JSONSerialization.data(withJSONObject:command).write(to:root.appendingPathComponent("fixture-command.json"),options:.atomic);guard wait(3,{state()["revision"] as? Int==revision}),let pid=state()["pid"] as? Int,let app=NSRunningApplication(processIdentifier:Int32(pid)) else{fatalError("Fixture did not acknowledge reset")};app.activate(options:[.activateAllWindows]);Thread.sleep(forTimeInterval:0.2);guard NSWorkspace.shared.frontmostApplication?.processIdentifier==Int32(pid) else{fatalError("Fixture lost focus before typing")}}
func trigger(_ sample:Sample,_ enter:Bool=false){stroke(53);stroke(41);for key in sample.keys{stroke(key)};stroke(enter ? 36:49)}
var results=[[String:Any]]()
func record(_ name:String,_ passed:Bool,_ started:Date){let value=state();let row:[String:Any]=["case":name,"passed":passed,"seconds":Date().timeIntervalSince(started),"arrows":value["arrows"] ?? -1,"writes":value["writes"] ?? -1,"caret":value["caret"] ?? -1];results.append(row);try! JSONSerialization.data(withJSONObject:results,options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent("fixture-results.json"));print("\(passed ? "PASS":"FAIL") \(name) \(row)");fflush(stdout)}
for sample in Sample.all+Array(repeating:Sample.all[0],count:3) {
    reset("direct");let start=Date();trigger(sample)
    let placed=wait(4,{state()["text"] as? String==sample.before+sample.after && state()["caret"] as? Int==sample.before.utf16.count})
    if placed{stroke(7)}
    let typed=wait(2,{state()["text"] as? String==sample.before+"x"+sample.after})
    record(sample.name,placed&&typed&&(state()["arrows"] as? Int)==0&&(state()["writes"] as? Int ?? 0)>0,start)
}
let short=Sample.all[0]
for mode in ["fallback","reject","delayed","focus","rewrite","selection","surrounded","enter","buffered"] {
    let initial=mode=="surrounded" ? "OUTER Hello , thanks! END":""
    reset(["surrounded","enter","buffered"].contains(mode) ? "direct":mode,initial,mode=="surrounded" ? 6:0)
    let start=Date();trigger(short,mode=="enter")
    if mode=="buffered" {stroke(7)}
    _=wait(3,{(state()["text"] as? String)?.contains("Hello ")==true});Thread.sleep(forTimeInterval:1.2)
    let value=state();let arrows=value["arrows"] as? Int ?? -1;let writes=value["writes"] as? Int ?? -1;let caret=value["caret"] as? Int ?? -1
    let expected=short.before+short.after
    let passed:Bool
    switch mode {
    case "fallback":passed=value["text"] as? String==expected && caret==6 && arrows==9 && writes==0
    case "reject":passed=value["text"] as? String==expected && caret==15 && arrows==0 && writes==1
    case "delayed":passed=value["text"] as? String==expected && caret==6 && arrows==0 && writes==1
    case "focus":passed=value["text"] as? String==expected && value["otherText"] as? String=="KEEP" && value["otherCaret"] as? Int==4 && arrows==0 && writes==0
    case "rewrite":passed=value["text"] as? String==expected+"!" && caret==16 && arrows==0 && writes==0
    case "selection":passed=value["length"] as? Int==2 && arrows==0 && writes==0
    case "surrounded":passed=value["text"] as? String=="OUTER "+expected+"Hello , thanks! END" && caret==12 && arrows==0 && writes==1
    case "buffered":passed=value["text"] as? String==short.before+"x"+short.after && caret==7 && arrows==0 && writes==1
    default:passed=value["text"] as? String==expected && caret==6 && arrows==0 && writes==1
    }
    record(mode,passed,start)
}
print("DONE \(results.count) cases; \(results.filter{($0["passed"] as? Bool)==true}.count) passed")
exit(results.allSatisfy{($0["passed"] as? Bool)==true} ? 0:1)
