class TyperelayContext {
	constructor(){this.pending=false;workspace.windowActivated.connect(()=>this.send());this.timer=new QTimer();this.timer.interval=500;this.timer.timeout.connect(()=>this.send());this.timer.start();this.send();}
	send(){if(this.pending)return;const window=workspace.activeWindow;if(!window)return;const value={pid:window.pid||0,app:String(window.desktopFileName||window.resourceClass||''),window:String(window.internalId),layout:{}};this.pending=true;callDBus('org.typerelay.Capture','/org/typerelay/Capture','org.typerelay.Capture1','Context',JSON.stringify(value),()=>{this.pending=false;});}
}
new TyperelayContext();
