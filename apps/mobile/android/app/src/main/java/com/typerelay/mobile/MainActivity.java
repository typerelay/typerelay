package com.typerelay.mobile;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
 @Override public void onCreate(Bundle savedInstanceState) { registerPlugin(TypeRelayPlugin.class); super.onCreate(savedInstanceState); }
}
