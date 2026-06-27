package com.gwaves.novelreader.gateway;

import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.provider.Settings;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(name = "NovelReaderTts")
public class NovelReaderTtsPlugin extends Plugin {
    private static final String XIAOMI_TTS_ENGINE = "com.xiaomi.mibrain.speech";
    private static final long INIT_TIMEOUT_MS = 8000L;
    private static final int INITIAL_PREFETCH_READY_COUNT = 3;
    private static final float MIN_SPEECH_RATE = 0.5f;
    private static final float MAX_SPEECH_RATE = 3.0f;
    private static final float MIN_SPEECH_PITCH = 0.5f;
    private static final float MAX_SPEECH_PITCH = 2.0f;

    private TextToSpeech tts;
    private boolean initializing = false;
    private boolean ready = false;
    private int initStatus = TextToSpeech.ERROR;
    private Handler mainHandler;
    private Runnable initTimeoutRunnable;
    private PowerManager.WakeLock speechWakeLock;
    private String queuedLastUtteranceId = null;
    private MediaPlayer prefetchedPlayer;
    private int prefetchGeneration = 0;
    private int prefetchWindow = 4;
    private int nextSynthesisIndex = 0;
    private int nextPlaybackIndex = 0;
    private boolean prefetchedPlaybackActive = false;
    private boolean prefetchSynthesisBusy = false;
    private PluginCall pendingPrefetchedPlaybackCall;
    private final List<PendingAction> pendingActions = new ArrayList<>();
    private final List<PrefetchItem> prefetchItems = new ArrayList<>();
    private final Map<String, Integer> synthesisIndexByUtteranceId = new HashMap<>();

    private static class PendingAction {
        final PluginCall call;
        final Runnable action;

        PendingAction(PluginCall call, Runnable action) {
            this.call = call;
            this.action = action;
        }
    }

    private static class PrefetchItem {
        final String utteranceId;
        final String synthesisId;
        final String text;
        final File file;
        boolean ready = false;
        String error = null;

        PrefetchItem(String utteranceId, String synthesisId, String text, File file) {
            this.utteranceId = utteranceId;
            this.synthesisId = synthesisId;
            this.text = text;
            this.file = file;
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
            float rate = floatValue(call, "rate", 1.0f, MIN_SPEECH_RATE, MAX_SPEECH_RATE);
            float pitch = floatValue(call, "pitch", 1.0f, MIN_SPEECH_PITCH, MAX_SPEECH_PITCH);

            if (text.trim().isEmpty()) {
                call.reject("Missing text.");
                return;
            }
            if (utteranceId.trim().isEmpty()) {
                call.reject("Missing utteranceId.");
                return;
            }

            Locale locale = Locale.forLanguageTag(localeTag);
            if (!applySpeechSettings(locale, voiceId, rate, pitch)) {
                call.reject("当前系统 TTS 不支持 " + localeTag + "，请安装或启用对应语音包。");
                return;
            }

            queuedLastUtteranceId = utteranceId;
            acquireSpeechWakeLock();
            int status = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            if (status == TextToSpeech.SUCCESS) {
                call.resolve();
            } else {
                releaseSpeechWakeLock();
                call.reject("系统 TTS 启动朗读失败。");
            }
        });
    }

    @PluginMethod
    public void speakQueue(PluginCall call) {
        ensureTts(call, () -> {
            JSArray utterances = call.getArray("utterances");
            String localeTag = call.getString("locale", "zh-CN");
            String voiceId = call.getString("voiceId", "");
            float rate = floatValue(call, "rate", 1.0f, MIN_SPEECH_RATE, MAX_SPEECH_RATE);
            float pitch = floatValue(call, "pitch", 1.0f, MIN_SPEECH_PITCH, MAX_SPEECH_PITCH);

            if (utterances == null || utterances.length() == 0) {
                call.reject("Missing utterances.");
                return;
            }

            Locale locale = Locale.forLanguageTag(localeTag);
            if (!applySpeechSettings(locale, voiceId, rate, pitch)) {
                call.reject("当前系统 TTS 不支持 " + localeTag + "，请安装或启用对应语音包。");
                return;
            }

            tts.stop();
            queuedLastUtteranceId = null;
            acquireSpeechWakeLock();

            for (int index = 0; index < utterances.length(); index++) {
                JSONObject item = utterances.optJSONObject(index);
                if (item == null) continue;

                String text = item.optString("text", "");
                String utteranceId = item.optString("utteranceId", "");
                if (text.trim().isEmpty() || utteranceId.trim().isEmpty()) continue;

                queuedLastUtteranceId = utteranceId;
                int queueMode = index == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
                int status = tts.speak(text, queueMode, null, utteranceId);
                if (status != TextToSpeech.SUCCESS) {
                    tts.stop();
                    queuedLastUtteranceId = null;
                    releaseSpeechWakeLock();
                    call.reject("系统 TTS 启动朗读失败。");
                    return;
                }
            }

            if (queuedLastUtteranceId == null) {
                releaseSpeechWakeLock();
                call.reject("Missing valid utterances.");
                return;
            }

            call.resolve();
        });
    }

    @PluginMethod
    public void speakPrefetchedQueue(PluginCall call) {
        ensureTts(call, () -> {
            JSArray utterances = call.getArray("utterances");
            String localeTag = call.getString("locale", "zh-CN");
            String voiceId = call.getString("voiceId", "");
            float rate = floatValue(call, "rate", 1.0f, MIN_SPEECH_RATE, MAX_SPEECH_RATE);
            float pitch = floatValue(call, "pitch", 1.0f, MIN_SPEECH_PITCH, MAX_SPEECH_PITCH);
            Double requestedWindow = call.getDouble("prefetchWindow");

            if (utterances == null || utterances.length() == 0) {
                call.reject("Missing utterances.");
                return;
            }

            Locale locale = Locale.forLanguageTag(localeTag);
            if (!applySpeechSettings(locale, voiceId, rate, pitch)) {
                call.reject("当前系统 TTS 不支持 " + localeTag + "，请安装或启用对应语音包。");
                return;
            }

            stopPrefetchedPlayback();
            tts.stop();
            queuedLastUtteranceId = null;
            prefetchGeneration += 1;
            prefetchWindow = requestedWindow == null ? 4 : Math.max(1, Math.min(12, requestedWindow.intValue()));
            nextSynthesisIndex = 0;
            nextPlaybackIndex = 0;
            prefetchedPlaybackActive = true;
            pendingPrefetchedPlaybackCall = call;
            acquireSpeechWakeLock();

            File cacheDir = new File(getContext().getCacheDir(), "novel-reader-tts-prefetch");
            if (!cacheDir.exists() && !cacheDir.mkdirs()) {
                prefetchedPlaybackActive = false;
                releaseSpeechWakeLock();
                rejectPendingPrefetchedPlaybackStart("无法创建 TTS 预取缓存目录。");
                return;
            }

            for (int index = 0; index < utterances.length(); index++) {
                JSONObject item = utterances.optJSONObject(index);
                if (item == null) continue;

                String text = item.optString("text", "");
                String utteranceId = item.optString("utteranceId", "");
                if (text.trim().isEmpty() || utteranceId.trim().isEmpty()) continue;

                String synthesisId = "tts-prefetch-" + prefetchGeneration + "-" + index;
                File file = new File(cacheDir, synthesisId + ".wav");
                if (file.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
                prefetchItems.add(new PrefetchItem(utteranceId, synthesisId, text, file));
            }

            if (prefetchItems.isEmpty()) {
                prefetchedPlaybackActive = false;
                releaseSpeechWakeLock();
                rejectPendingPrefetchedPlaybackStart("Missing valid utterances.");
                return;
            }

            startPrefetchSynthesis();
            tryStartPrefetchedPlayback();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ensureTts(call, () -> {
            stopPrefetchedPlayback();
            tts.stop();
            queuedLastUtteranceId = null;
            releaseSpeechWakeLock();
            call.resolve();
        });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        ensureTts(call, () -> {
            tts.setSpeechRate(floatValue(call, "rate", 1.0f, MIN_SPEECH_RATE, MAX_SPEECH_RATE));
            call.resolve();
        });
    }

    @PluginMethod
    public void setPitch(PluginCall call) {
        ensureTts(call, () -> {
            tts.setPitch(floatValue(call, "pitch", 1.0f, MIN_SPEECH_PITCH, MAX_SPEECH_PITCH));
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
                    if (isPrefetchSynthesisId(utteranceId)) return;
                    notifyUtterance("utteranceStart", utteranceId, null);
                }

                @Override
                public void onDone(String utteranceId) {
                    if (handlePrefetchSynthesisDone(utteranceId)) return;
                    notifyUtterance("utteranceDone", utteranceId, null);
                    if (utteranceId != null && utteranceId.equals(queuedLastUtteranceId)) {
                        queuedLastUtteranceId = null;
                        releaseSpeechWakeLock();
                    }
                }

                @Override
                public void onError(String utteranceId) {
                    if (handlePrefetchSynthesisError(utteranceId, "系统 TTS 预取失败。")) return;
                    queuedLastUtteranceId = null;
                    releaseSpeechWakeLock();
                    notifyUtterance("utteranceError", utteranceId, "系统 TTS 朗读失败。");
                }

                @Override
                public void onError(String utteranceId, int errorCode) {
                    if (handlePrefetchSynthesisError(utteranceId, "系统 TTS 预取失败：" + errorCode)) return;
                    queuedLastUtteranceId = null;
                    releaseSpeechWakeLock();
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

    private boolean applySpeechSettings(Locale locale, String voiceId, float rate, float pitch) {
        int languageStatus = tts.setLanguage(locale);
        if (languageStatus == TextToSpeech.LANG_MISSING_DATA || languageStatus == TextToSpeech.LANG_NOT_SUPPORTED) {
            return false;
        }

        if (!voiceId.trim().isEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Voice voice = findVoice(voiceId);
            if (voice != null) {
                tts.setVoice(voice);
            }
        }

        tts.setSpeechRate(rate);
        tts.setPitch(pitch);
        return true;
    }

    private void startPrefetchSynthesis() {
        if (!prefetchedPlaybackActive || tts == null) return;
        if (prefetchSynthesisBusy) return;

        if (nextSynthesisIndex >= prefetchItems.size() || nextSynthesisIndex >= nextPlaybackIndex + prefetchWindow) return;

        PrefetchItem item = prefetchItems.get(nextSynthesisIndex);
        synthesisIndexByUtteranceId.put(item.synthesisId, nextSynthesisIndex);
        prefetchSynthesisBusy = true;

        int status;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            status = tts.synthesizeToFile(item.text, new Bundle(), item.file, item.synthesisId);
        } else {
            status = TextToSpeech.ERROR;
        }

        if (status != TextToSpeech.SUCCESS) {
            prefetchSynthesisBusy = false;
            synthesisIndexByUtteranceId.remove(item.synthesisId);
            item.error = "系统 TTS 预取启动失败。";
        }

        nextSynthesisIndex += 1;
    }

    private void tryStartPrefetchedPlayback() {
        if (!prefetchedPlaybackActive || prefetchedPlayer != null) return;

        if (nextPlaybackIndex >= prefetchItems.size()) {
            finishPrefetchedPlayback();
            return;
        }

        PrefetchItem item = prefetchItems.get(nextPlaybackIndex);
        if (item.error != null) {
            failPrefetchedPlayback(item.utteranceId, item.error);
            return;
        }
        if (nextPlaybackIndex == 0 && countReadyPrefetchItemsFromStart() < Math.min(INITIAL_PREFETCH_READY_COUNT, prefetchItems.size())) {
            return;
        }
        if (!item.ready) return;

        MediaPlayer player = new MediaPlayer();
        prefetchedPlayer = player;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                player.setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                );
            }
            player.setDataSource(item.file.getAbsolutePath());
            player.setOnCompletionListener(donePlayer -> {
                notifyUtterance("utteranceDone", item.utteranceId, null);
                releasePrefetchedPlayer(donePlayer);
                //noinspection ResultOfMethodCallIgnored
                item.file.delete();
                nextPlaybackIndex += 1;
                startPrefetchSynthesis();
                tryStartPrefetchedPlayback();
            });
            player.setOnErrorListener((errorPlayer, what, extra) -> {
                releasePrefetchedPlayer(errorPlayer);
                failPrefetchedPlayback(item.utteranceId, "TTS 预取音频播放失败：" + what + "/" + extra);
                return true;
            });
            player.prepare();
            player.start();
            resolvePendingPrefetchedPlaybackStart();
            notifyUtterance("utteranceStart", item.utteranceId, null);
        } catch (IOException | IllegalStateException error) {
            releasePrefetchedPlayer(player);
            failPrefetchedPlayback(item.utteranceId, "TTS 预取音频播放失败。");
        }
    }

    private boolean isPrefetchSynthesisId(String utteranceId) {
        return utteranceId != null && synthesisIndexByUtteranceId.containsKey(utteranceId);
    }

    private int countReadyPrefetchItemsFromStart() {
        int count = 0;
        for (PrefetchItem item : prefetchItems) {
            if (!item.ready) break;
            count += 1;
        }
        return count;
    }

    private boolean handlePrefetchSynthesisDone(String utteranceId) {
        if (utteranceId == null || !synthesisIndexByUtteranceId.containsKey(utteranceId)) return false;
        Integer index = synthesisIndexByUtteranceId.remove(utteranceId);
        prefetchSynthesisBusy = false;
        if (index != null && index >= 0 && index < prefetchItems.size()) {
            prefetchItems.get(index).ready = true;
        }
        if (mainHandler == null) {
            mainHandler = new Handler(Looper.getMainLooper());
        }
        mainHandler.post(() -> {
            startPrefetchSynthesis();
            tryStartPrefetchedPlayback();
        });
        return true;
    }

    private boolean handlePrefetchSynthesisError(String utteranceId, String message) {
        if (utteranceId == null || !synthesisIndexByUtteranceId.containsKey(utteranceId)) return false;
        Integer index = synthesisIndexByUtteranceId.remove(utteranceId);
        prefetchSynthesisBusy = false;
        if (index != null && index >= 0 && index < prefetchItems.size()) {
            prefetchItems.get(index).error = message;
        }
        if (mainHandler == null) {
            mainHandler = new Handler(Looper.getMainLooper());
        }
        mainHandler.post(() -> {
            startPrefetchSynthesis();
            tryStartPrefetchedPlayback();
        });
        return true;
    }

    private void failPrefetchedPlayback(String utteranceId, String message) {
        stopPrefetchedPlayback(false);
        releaseSpeechWakeLock();
        rejectPendingPrefetchedPlaybackStart(message);
        notifyUtterance("utteranceError", utteranceId, message);
    }

    private void finishPrefetchedPlayback() {
        stopPrefetchedPlayback();
        releaseSpeechWakeLock();
    }

    private void releasePrefetchedPlayer(MediaPlayer player) {
        if (player == null) return;
        if (prefetchedPlayer == player) {
            prefetchedPlayer = null;
        }
        try {
            player.reset();
        } catch (Exception ignored) {
            // Ignore cleanup failures.
        }
        player.release();
    }

    private void stopPrefetchedPlayback() {
        stopPrefetchedPlayback(true);
    }

    private void stopPrefetchedPlayback(boolean rejectPending) {
        if (rejectPending) {
            rejectPendingPrefetchedPlaybackStart("TTS 预取播放已停止。");
        }
        prefetchedPlaybackActive = false;
        prefetchGeneration += 1;
        synthesisIndexByUtteranceId.clear();
        if (prefetchedPlayer != null) {
            try {
                prefetchedPlayer.stop();
            } catch (Exception ignored) {
                // Ignore cleanup failures.
            }
            releasePrefetchedPlayer(prefetchedPlayer);
        }
        for (PrefetchItem item : prefetchItems) {
            if (item.file.exists()) {
                //noinspection ResultOfMethodCallIgnored
                item.file.delete();
            }
        }
        prefetchItems.clear();
        nextSynthesisIndex = 0;
        nextPlaybackIndex = 0;
        prefetchSynthesisBusy = false;
    }

    private void resolvePendingPrefetchedPlaybackStart() {
        if (pendingPrefetchedPlaybackCall == null) return;
        pendingPrefetchedPlaybackCall.resolve();
        pendingPrefetchedPlaybackCall = null;
    }

    private void rejectPendingPrefetchedPlaybackStart(String message) {
        if (pendingPrefetchedPlaybackCall == null) return;
        pendingPrefetchedPlaybackCall.reject(message);
        pendingPrefetchedPlaybackCall = null;
    }

    private void acquireSpeechWakeLock() {
        if (speechWakeLock == null) {
            PowerManager powerManager = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            speechWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NovelReader:TtsPlayback");
            speechWakeLock.setReferenceCounted(false);
        }
        if (!speechWakeLock.isHeld()) {
            speechWakeLock.acquire();
        }
    }

    private void releaseSpeechWakeLock() {
        if (speechWakeLock != null && speechWakeLock.isHeld()) {
            speechWakeLock.release();
        }
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
            stopPrefetchedPlayback();
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        queuedLastUtteranceId = null;
        releaseSpeechWakeLock();
        ready = false;
        super.handleOnDestroy();
    }
}
