package com.gwaves.novelreader.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NovelReaderTtsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
