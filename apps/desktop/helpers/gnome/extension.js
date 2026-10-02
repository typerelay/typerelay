import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

export default class TyperelayContext extends Extension {
	enable() {
		this.settings=new Gio.Settings({schema_id:'org.gnome.desktop.input-sources'});
		this.focusSignal=global.display.connect('notify::focus-window',()=>this.send());
		this.sourceManager=Keyboard.getInputSourceManager();
		this.sourceSignal=this.sourceManager.connect('current-source-changed',()=>this.send());
		this.timer=GLib.timeout_add(GLib.PRIORITY_DEFAULT,500,()=>{this.send();return GLib.SOURCE_CONTINUE;});
		this.send();
	}
	send() {
		if(this.sending)return;
		const window=global.display.focus_window;const source=this.sourceManager.currentSource;if(!window||!source)return;
		const [layout,variant='']=String(source.xkbId||source.id).split('+');const app=Shell.WindowTracker.get_default().get_window_app(window);
		const value={pid:window.get_pid(),app:app?.get_id()||window.get_wm_class()||'',window:String(window.get_stable_sequence()),layout:{layout,variant,options:this.settings.get_strv('xkb-options').join(','),group:0},ime:source.type==='ibus'?source.id:null};
		this.sending=true;
		Gio.DBus.session.call('org.typerelay.Capture','/org/typerelay/Capture','org.typerelay.Capture1','Context',new GLib.Variant('(s)',[JSON.stringify(value)]),null,Gio.DBusCallFlags.NO_AUTO_START,300,null,(connection,result)=>{try{connection.call_finish(result);}catch{}this.sending=false;});
	}
	disable() {
		if(this.focusSignal)global.display.disconnect(this.focusSignal);
		if(this.sourceSignal)this.sourceManager.disconnect(this.sourceSignal);
		if(this.timer)GLib.Source.remove(this.timer);
		this.focusSignal=0;this.sourceSignal=0;this.timer=0;this.sourceManager=null;this.settings=null;
	}
}
