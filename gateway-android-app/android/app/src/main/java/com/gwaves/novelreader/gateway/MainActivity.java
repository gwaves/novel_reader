package com.gwaves.novelreader.gateway;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(GatewayAudioPlugin.class);
    registerPlugin(NovelReaderTtsPlugin.class);
    super.onCreate(savedInstanceState);
    protectStatusBarArea();
  }

  private void protectStatusBarArea() {
    Window window = getWindow();
    window.setStatusBarColor(Color.rgb(248, 250, 252));
    WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightStatusBars(true);

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      return;
    }

    View content = findViewById(android.R.id.content);
    if (!(content instanceof ViewGroup)) {
      return;
    }

    ViewGroup contentGroup = (ViewGroup) content;
    View appContent = contentGroup.getChildCount() > 0 ? contentGroup.getChildAt(0) : contentGroup;
    int initialPaddingLeft = appContent.getPaddingLeft();
    int initialPaddingTop = appContent.getPaddingTop();
    int initialPaddingRight = appContent.getPaddingRight();
    int initialPaddingBottom = appContent.getPaddingBottom();

    ViewCompat.setOnApplyWindowInsetsListener(appContent, (view, windowInsets) -> {
      Insets statusBars = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars());
      view.setPadding(
        initialPaddingLeft,
        initialPaddingTop + statusBars.top,
        initialPaddingRight,
        initialPaddingBottom
      );
      return windowInsets;
    });
    ViewCompat.requestApplyInsets(appContent);
  }
}
