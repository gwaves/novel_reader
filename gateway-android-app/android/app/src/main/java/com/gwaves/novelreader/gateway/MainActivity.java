package com.gwaves.novelreader.gateway;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebView;
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
    protectSystemBarAreas();
  }

  private void protectSystemBarAreas() {
    Window window = getWindow();
    window.setStatusBarColor(Color.rgb(248, 250, 252));
    window.setNavigationBarColor(Color.rgb(248, 250, 252));
    WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightStatusBars(true);
    WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightNavigationBars(true);

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
      Insets navigationBars = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars());
      Insets tappableElements = windowInsets.getInsets(WindowInsetsCompat.Type.tappableElement());
      setWebSafeAreaBottom(bottomSystemBarInset(navigationBars, tappableElements));
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

  private int bottomSystemBarInset(Insets navigationBars, Insets tappableElements) {
    if (navigationInteractionMode() == 2) {
      return 0;
    }
    return tappableElements.bottom > 0 ? tappableElements.bottom : navigationBars.bottom;
  }

  private int navigationInteractionMode() {
    int resourceId = getResources().getIdentifier("config_navBarInteractionMode", "integer", "android");
    if (resourceId == 0) {
      return -1;
    }

    try {
      return getResources().getInteger(resourceId);
    } catch (Exception error) {
      return -1;
    }
  }

  private void setWebSafeAreaBottom(int bottomInset) {
    WebView webView = getBridge().getWebView();
    if (webView == null) {
      return;
    }

    String script = "document.documentElement.style.setProperty('--native-safe-area-bottom', '" + bottomInset + "px');";
    webView.post(() -> webView.evaluateJavascript(script, null));
  }
}
