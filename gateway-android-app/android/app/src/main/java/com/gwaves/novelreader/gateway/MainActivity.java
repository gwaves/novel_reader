package com.gwaves.novelreader.gateway;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(GatewayAudioPlugin.class);
    registerPlugin(NovelReaderTtsPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
