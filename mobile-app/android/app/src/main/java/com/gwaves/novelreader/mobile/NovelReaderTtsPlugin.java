package com.gwaves.novelreader.mobile;

import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(name = "NovelReaderTts")
public class NovelReaderTtsPlugin extends Plugin {
    private static final String XIAOMI_TTS_ENGINE = "com.xiaomi.mibrain.speech";
    private static final long INIT_TIMEOUT_MS = 8000L;

    private TextToSpeech tts;
    private boolean initializing = false;
    private boolean ready = false;
    private int initStatus = TextToSpeech.ERROR;
    private Handler mainHandler;
    private Runnable initTimeoutRunnable;
    private final List<PendingAction> pendingActions = new ArrayList<>();

    private static class PendingAction {
        final PluginCall call;
        final Runnable action;

        PendingAction(PluginCall call, Runnable action) {
            this.call = call;
            this.action = action;
        }
    }

    @PluginMethod
    public void getAvailability(PluginCall call) {
        ensureTts(call, () -> {
            String localeTag = call.getString("locale", "zh-CN");
            Locale locale = Locale.forLanguageTag(localeTag);
            int languageStatus = tts.isLanguageAvailable(locale);

            JSObject result = new JSObject();
            result.put("available", ready);
            result.put("languageAvailable", languageStatus >= TextToSpeech.LANG_AVAILABLE);
            result.put("engine", tts.getDefaultEngine());
            result.put("voices", listVoices(locale));
            if (languageStatus < TextToSpeech.LANG_AVAILABLE) {
                result.put("error", "当前系统 TTS 不支持 " + localeTag + "，请安装或启用对应语音包。");
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        Intent intent = new Intent("com.android.settings.TTS_SETTINGS");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            try {
                getContext().startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                call.resolve();
            } catch (Exception fallbackError) {
                call.reject("无法打开系统语音设置。");
            }
        }
    }

    @PluginMethod
    public void checkTtsData(PluginCall call) {
        Intent intent = new Intent(TextToSpeech.Engine.ACTION_CHECK_TTS_DATA);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开系统 TTS 数据检查页面。");
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        ensureTts(call, () -> {
            String text = call.getString("text", "");
            String utteranceId = call.getString("utteranceId", "");
            String localeTag = call.getString("locale", "zh-CN");
            String voiceId = call.getString("voiceId", "");
            float rate = floatValue(call, "rate", 1.0f, 0.5f, 2.0f);
            float pitch = floatValue(call, "pitch", 1.0f, 0.5f, 2.0f);

            if (text.trim().isEmpty()) {
                call.reject("Missing text.");
                return;
            }
            if (utteranceId.trim().isEmpty()) {
                call.reject("Missing utteranceId.");
                return;
            }

            Locale locale = Locale.forLanguageTag(localeTag);
            int languageStatus = tts.setLanguage(locale);
            if (languageStatus == TextToSpeech.LANG_MISSING_DATA || languageStatus == TextToSpeech.LANG_NOT_SUPPORTED) {
                call.reject("当前系统 TTS 不支持 " + localeTag + "，请安装或启用对应语音包。");
                return;
            }

            if (!voiceId.trim().isEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                Voice voice = findVoice(voiceId);
                if (voice != null) {
                    tts.setVoice(voice);
                }
            }

            tts.setSpeechRate(rate);
            tts.setPitch(pitch);

            int status = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            if (status == TextToSpeech.SUCCESS) {
                call.resolve();
            } else {
                call.reject("系统 TTS 启动朗读失败。");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ensureTts(call, () -> {
            tts.stop();
            call.resolve();
        });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        ensureTts(call, () -> {
            tts.setSpeechRate(floatValue(call, "rate", 1.0f, 0.5f, 2.0f));
            call.resolve();
        });
    }

    @PluginMethod
    public void setPitch(PluginCall call) {
        ensureTts(call, () -> {
            tts.setPitch(floatValue(call, "pitch", 1.0f, 0.5f, 2.0f));
            call.resolve();
        });
    }

    private void ensureTts(PluginCall call, Runnable action) {
        if (ready && tts != null) {
            getActivity().runOnUiThread(action);
            return;
        }

        pendingActions.add(new PendingAction(call, action));
        if (initializing) return;

        initializing = true;
        if (mainHandler == null) {
            mainHandler = new Handler(Looper.getMainLooper());
        }
        getActivity().runOnUiThread(() -> {
            List<String> engines = resolveTtsEngines();
            initializeEngine(engines, 0);
        });
    }

    private void initializeEngine(List<String> engines, int index) {
        if (index >= engines.size()) {
            initializing = false;
            ready = false;
            rejectPending("系统 TTS 初始化失败：" + initStatus + "。请确认系统文字转语音引擎可播放示例语音。");
            return;
        }

        String engine = engines.get(index);
        initTimeoutRunnable = () -> {
            if (!initializing) return;
            if (tts != null) {
                tts.shutdown();
                tts = null;
            }
            initializeEngine(engines, index + 1);
        };
        mainHandler.postDelayed(initTimeoutRunnable, INIT_TIMEOUT_MS);

        tts = new TextToSpeech(getContext().getApplicationContext(), status -> {
            if (initTimeoutRunnable != null) {
                mainHandler.removeCallbacks(initTimeoutRunnable);
                initTimeoutRunnable = null;
            }
            initStatus = status;
            ready = status == TextToSpeech.SUCCESS;

            if (!ready) {
                if (tts != null) {
                    tts.shutdown();
                    tts = null;
                }
                initializeEngine(engines, index + 1);
                return;
            }

            initializing = false;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    notifyUtterance("utteranceStart", utteranceId, null);
                }

                @Override
                public void onDone(String utteranceId) {
                    notifyUtterance("utteranceDone", utteranceId, null);
                }

                @Override
                public void onError(String utteranceId) {
                    notifyUtterance("utteranceError", utteranceId, "系统 TTS 朗读失败。");
                }

                @Override
                public void onError(String utteranceId, int errorCode) {
                    notifyUtterance("utteranceError", utteranceId, "系统 TTS 朗读失败：" + errorCode);
                }
            });

            List<PendingAction> actions = drainPendingActions();
            for (PendingAction pending : actions) {
                pending.action.run();
            }
        }, engine);
    }

    private List<String> resolveTtsEngines() {
        LinkedHashSet<String> engines = new LinkedHashSet<>();

        String defaultEngine = Settings.Secure.getString(getContext().getContentResolver(), "tts_default_synth");
        if (defaultEngine != null && !defaultEngine.trim().isEmpty()) {
            engines.add(defaultEngine.trim());
        }

        Intent intent = new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE);
        List<ResolveInfo> services = getContext().getPackageManager().queryIntentServices(intent, 0);
        for (ResolveInfo service : services) {
            if (service.serviceInfo == null || service.serviceInfo.packageName == null) continue;
            if (XIAOMI_TTS_ENGINE.equals(service.serviceInfo.packageName)) {
                engines.add(service.serviceInfo.packageName);
            }
        }
        for (ResolveInfo service : services) {
            if (service.serviceInfo == null || service.serviceInfo.packageName == null) continue;
            engines.add(service.serviceInfo.packageName);
        }

        if (engines.isEmpty()) {
            engines.add(null);
        }
        return new ArrayList<>(engines);
    }

    private List<PendingAction> drainPendingActions() {
        List<PendingAction> actions = new ArrayList<>(pendingActions);
        pendingActions.clear();
        return actions;
    }

    private void rejectPending(String message) {
        List<PendingAction> actions = drainPendingActions();
        for (PendingAction pending : actions) {
            pending.call.reject(message);
        }
    }

    private JSArray listVoices(Locale preferredLocale) {
        JSArray voicesArray = new JSArray();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP || tts == null) {
            return voicesArray;
        }

        Set<Voice> voices = tts.getVoices();
        if (voices == null) return voicesArray;

        for (Voice voice : voices) {
            Locale locale = voice.getLocale();
            if (preferredLocale != null && locale != null) {
                String preferredLanguage = preferredLocale.getLanguage();
                if (!preferredLanguage.equals(locale.getLanguage())) {
                    continue;
                }
            }

            JSObject item = new JSObject();
            item.put("id", voice.getName());
            item.put("name", voice.getName());
            item.put("locale", locale == null ? "" : locale.toLanguageTag());
            item.put("quality", voice.getQuality());
            item.put("latency", voice.getLatency());
            item.put("requiresNetwork", voice.isNetworkConnectionRequired());
            voicesArray.put(item);
        }

        return voicesArray;
    }

    private Voice findVoice(String voiceId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP || tts == null) return null;
        Set<Voice> voices = tts.getVoices();
        if (voices == null) return null;
        for (Voice voice : voices) {
            if (voice.getName().equals(voiceId)) {
                return voice;
            }
        }
        return null;
    }

    private float floatValue(PluginCall call, String key, float fallback, float min, float max) {
        Double value = call.getDouble(key);
        if (value == null || value.isNaN() || value.isInfinite()) return fallback;
        return Math.max(min, Math.min(max, value.floatValue()));
    }

    private void notifyUtterance(String eventName, String utteranceId, String error) {
        JSObject event = new JSObject();
        event.put("utteranceId", utteranceId);
        if (error != null) {
            event.put("error", error);
        }
        notifyListeners(eventName, event);
    }

    @Override
    protected void handleOnDestroy() {
        if (mainHandler != null && initTimeoutRunnable != null) {
            mainHandler.removeCallbacks(initTimeoutRunnable);
            initTimeoutRunnable = null;
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        ready = false;
        super.handleOnDestroy();
    }
}
