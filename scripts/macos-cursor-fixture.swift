// Native regression target. Run in the logged-in GUI session: swift macos-cursor-fixture.swift <test-directory>
import AppKit
import Foundation

final class CursorView: NSTextView {
    var mode="direct"
    var arrows=0
    var writes=0
    weak var alternate: NSTextView?
    override func keyDown(with event:NSEvent) {if event.keyCode==123{arrows+=1};super.keyDown(with:event)}
    override func isAccessibilitySelectorAllowed(_ selector:Selector)->Bool {
        if mode=="fallback" && NSStringFromSelector(selector)=="setAccessibilitySelectedTextRange:" {return false}
        return super.isAccessibilitySelectorAllowed(selector)
    }
    override func accessibilityIsAttributeSettable(_ attribute:NSAccessibility.Attribute)->Bool {
        if mode=="fallback" && attribute == .selectedTextRange {return false}
        return super.accessibilityIsAttributeSettable(attribute)
    }
    override func setAccessibilitySelectedTextRange(_ range:NSRange) {
        writes+=1
        if mode=="reject" {return}
        if mode=="delayed" {DispatchQueue.main.asyncAfter(deadline:.now()+0.5){self.setSelectedRange(range)};return}
        super.setAccessibilitySelectedTextRange(range)
    }
    override func paste(_ sender:Any?) {
        super.paste(sender)
        if mode=="focus" {window?.makeFirstResponder(alternate)}
        if mode=="rewrite" {string+="!";setSelectedRange(NSRange(location:(string as NSString).length,length:0))}
        if mode=="selection" {setSelectedRange(NSRange(location:1,length:2))}
    }
}
let root=URL(fileURLWithPath:CommandLine.arguments[1])
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let menu=NSMenu()
let edit=NSMenuItem(title:"Edit",action:nil,keyEquivalent:"")
let actions=NSMenu(title:"Edit")
actions.addItem(withTitle:"Paste",action:#selector(NSTextView.paste(_:)),keyEquivalent:"v")
actions.addItem(withTitle:"Copy",action:#selector(NSTextView.copy(_:)),keyEquivalent:"c")
actions.addItem(withTitle:"Select All",action:#selector(NSTextView.selectAll(_:)),keyEquivalent:"a")
edit.submenu=actions;menu.addItem(edit);app.mainMenu=menu
let window=NSWindow(contentRect:NSRect(x:100,y:100,width:700,height:450),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
window.title="TypeRelay cursor regression fixture"
let main=CursorView(frame:NSRect(x:0,y:80,width:700,height:370))
main.isRichText=false
let other=NSTextView(frame:NSRect(x:0,y:0,width:700,height:75))
other.isRichText=false
main.alternate=other
window.contentView!.addSubview(main)
window.contentView!.addSubview(other)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(main)
app.activate(ignoringOtherApps:true)
var revision:Int = -1
let timer=Timer.scheduledTimer(withTimeInterval:0.03,repeats:true){_ in
    if let data=try? Data(contentsOf:root.appendingPathComponent("fixture-command.json")),let command=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let next=command["revision"] as? Int,next != revision {
        revision=next;main.mode=command["mode"] as? String ?? "direct";main.string=command["initial"] as? String ?? "";main.setSelectedRange(NSRange(location:command["caret"] as? Int ?? 0,length:0));main.arrows=0;main.writes=0;other.string="KEEP";other.setSelectedRange(NSRange(location:4,length:0));window.makeFirstResponder(main);app.activate(ignoringOtherApps:true)
    }
    let state:[String:Any]=["revision":revision,"pid":ProcessInfo.processInfo.processIdentifier,"text":main.string,"caret":main.selectedRange().location,"length":main.selectedRange().length,"arrows":main.arrows,"writes":main.writes,"otherText":other.string,"otherCaret":other.selectedRange().location]
    if let data=try? JSONSerialization.data(withJSONObject:state){try? data.write(to:root.appendingPathComponent("fixture-state.json"),options:.atomic)}
}
app.run()
