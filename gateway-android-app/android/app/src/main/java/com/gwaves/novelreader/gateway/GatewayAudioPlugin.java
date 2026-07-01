package com.gwaves.novelreader.gateway;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "GatewayAudio")
public class GatewayAudioPlugin extends Plugin {
  @PluginMethod
  public void downloadAudio(PluginCall call) {
    String url = call.getString("url");
    String token = call.getString("token");
    String deviceId = call.getString("deviceId", "");
    String deviceName = call.getString("deviceName", "Android Phone");
    String deviceModel = call.getString("deviceModel", "");
    String devicePlatform = call.getString("devicePlatform", "");
    String appVersion = call.getString("appVersion", "");
    String bookId = call.getString("bookId");
    String chapterId = call.getString("chapterId");

    if (url == null || token == null || bookId == null || chapterId == null) {
      call.reject("Missing downloadAudio parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        HttpURLConnection connection = null;
        File tempFile = null;
        try {
          File bookDir = new File(getContext().getFilesDir(), "audio/" + safeSegment(bookId));
          if (!bookDir.exists() && !bookDir.mkdirs()) {
            throw new IllegalStateException("Unable to create audio cache directory.");
          }

          File targetFile = new File(bookDir, safeSegment(chapterId) + ".mp3");
          if (targetFile.exists() && targetFile.isFile() && targetFile.length() > 0) {
            JSObject result = new JSObject();
            result.put("filePath", targetFile.getAbsolutePath());
            result.put("sizeBytes", targetFile.length());
            result.put("cached", true);
            call.resolve(result);
            return;
          }

          tempFile = File.createTempFile(safeSegment(chapterId) + "-", ".tmp", bookDir);

          connection = (HttpURLConnection) new URL(url).openConnection();
          connection.setConnectTimeout(15000);
          connection.setReadTimeout(180000);
          connection.setRequestProperty("Authorization", "Bearer " + token);
          setDeviceHeaders(connection, deviceId, deviceName, deviceModel, devicePlatform, appVersion);

          int status = connection.getResponseCode();
          if (status < 200 || status >= 300) {
            throw new IllegalStateException("Gateway HTTP " + status);
          }

          long sizeBytes = 0;
          byte[] buffer = new byte[1024 * 128];
          try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(tempFile, false)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
              output.write(buffer, 0, read);
              sizeBytes += read;
            }
          }

          if (targetFile.exists() && !targetFile.delete()) {
            throw new IllegalStateException("Unable to replace cached audio file.");
          }
          if (!tempFile.renameTo(targetFile)) {
            throw new IllegalStateException("Unable to finish cached audio file.");
          }

          JSObject result = new JSObject();
          result.put("filePath", targetFile.getAbsolutePath());
          result.put("sizeBytes", sizeBytes);
          call.resolve(result);
        } catch (Exception error) {
          if (tempFile != null && tempFile.exists()) {
            tempFile.delete();
          }
          call.reject(error.getMessage() == null ? "Audio download failed." : error.getMessage(), error);
        } finally {
          if (connection != null) {
            connection.disconnect();
          }
        }
      }
    );
  }

  @PluginMethod
  public void downloadPackage(PluginCall call) {
    String url = call.getString("url");
    String token = call.getString("token");
    String deviceId = call.getString("deviceId", "");
    String deviceName = call.getString("deviceName", "Android Phone");
    String deviceModel = call.getString("deviceModel", "");
    String devicePlatform = call.getString("devicePlatform", "");
    String appVersion = call.getString("appVersion", "");
    String bookId = call.getString("bookId");

    if (url == null || token == null || bookId == null) {
      call.reject("Missing downloadPackage parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        HttpURLConnection connection = null;
        File tempFile = null;
        try {
          File bookDir = new File(getContext().getFilesDir(), "packages/" + safeSegment(bookId));
          if (!bookDir.exists() && !bookDir.mkdirs()) {
            throw new IllegalStateException("Unable to create package cache directory.");
          }

          File targetFile = new File(bookDir, "package-full.json");
          tempFile = new File(bookDir, "package-full.tmp");

          connection = (HttpURLConnection) new URL(url).openConnection();
          connection.setConnectTimeout(15000);
          connection.setReadTimeout(600000);
          connection.setRequestProperty("Authorization", "Bearer " + token);
          setDeviceHeaders(connection, deviceId, deviceName, deviceModel, devicePlatform, appVersion);

          int status = connection.getResponseCode();
          if (status < 200 || status >= 300) {
            throw new IllegalStateException("Gateway HTTP " + status);
          }

          long totalBytes = connection.getContentLengthLong();
          long sizeBytes = 0;
          long lastProgressAt = 0;
          byte[] buffer = new byte[1024 * 256];
          try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(tempFile, false)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
              output.write(buffer, 0, read);
              sizeBytes += read;
              if (sizeBytes - lastProgressAt >= 1024 * 1024 || (totalBytes > 0 && sizeBytes == totalBytes)) {
                lastProgressAt = sizeBytes;
                notifyPackageProgress(bookId, "download", "downloading", sizeBytes, totalBytes);
              }
            }
          }

          if (targetFile.exists() && !targetFile.delete()) {
            throw new IllegalStateException("Unable to replace cached package file.");
          }
          if (!tempFile.renameTo(targetFile)) {
            throw new IllegalStateException("Unable to finish cached package file.");
          }

          JSObject result = new JSObject();
          result.put("filePath", targetFile.getAbsolutePath());
          result.put("sizeBytes", sizeBytes);
          notifyPackageProgress(bookId, "download", "downloaded", sizeBytes, totalBytes);
          call.resolve(result);
        } catch (Exception error) {
          if (tempFile != null && tempFile.exists()) {
            tempFile.delete();
          }
          call.reject(error.getMessage() == null ? "Package download failed." : error.getMessage(), error);
        } finally {
          if (connection != null) {
            connection.disconnect();
          }
        }
      }
    );
  }

  @PluginMethod
  public void downloadAndInstallApk(PluginCall call) {
    String url = call.getString("url");
    String fileName = call.getString("fileName", "ai_novel_reader.apk");

    if (url == null) {
      call.reject("Missing downloadAndInstallApk parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        HttpURLConnection connection = null;
        File tempFile = null;
        try {
          File updateDir = new File(getContext().getCacheDir(), "updates");
          if (!updateDir.exists() && !updateDir.mkdirs()) {
            throw new IllegalStateException("Unable to create update cache directory.");
          }

          String safeFileName = safeSegment(fileName);
          if (!safeFileName.endsWith(".apk")) safeFileName = safeFileName + ".apk";
          File targetFile = new File(updateDir, safeFileName);
          tempFile = new File(updateDir, safeFileName + ".tmp");

          connection = (HttpURLConnection) new URL(url).openConnection();
          connection.setConnectTimeout(15000);
          connection.setReadTimeout(600000);

          int status = connection.getResponseCode();
          if (status < 200 || status >= 300) {
            throw new IllegalStateException("Gateway HTTP " + status);
          }

          long sizeBytes = 0;
          byte[] buffer = new byte[1024 * 256];
          try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(tempFile, false)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
              output.write(buffer, 0, read);
              sizeBytes += read;
            }
          }

          if (targetFile.exists() && !targetFile.delete()) {
            throw new IllegalStateException("Unable to replace update APK.");
          }
          if (!tempFile.renameTo(targetFile)) {
            throw new IllegalStateException("Unable to finish update APK.");
          }

          Uri apkUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", targetFile);
          Intent installIntent = new Intent(Intent.ACTION_VIEW);
          installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
          installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
          installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          getContext().startActivity(installIntent);

          JSObject result = new JSObject();
          result.put("filePath", targetFile.getAbsolutePath());
          result.put("sizeBytes", sizeBytes);
          call.resolve(result);
        } catch (Exception error) {
          if (tempFile != null && tempFile.exists()) {
            tempFile.delete();
          }
          call.reject(error.getMessage() == null ? "APK update failed." : error.getMessage(), error);
        } finally {
          if (connection != null) {
            connection.disconnect();
          }
        }
      }
    );
  }

  private void setDeviceHeaders(
    HttpURLConnection connection,
    String deviceId,
    String deviceName,
    String deviceModel,
    String devicePlatform,
    String appVersion
  ) {
    setHeaderIfPresent(connection, "X-Device-Id", deviceId);
    setHeaderIfPresent(connection, "X-Device-Name", deviceName);
    setHeaderIfPresent(connection, "X-Device-Model", deviceModel);
    setHeaderIfPresent(connection, "X-Device-Platform", devicePlatform);
    setHeaderIfPresent(connection, "X-App-Version", appVersion);
  }

  private void setHeaderIfPresent(HttpURLConnection connection, String name, String value) {
    if (value != null && !value.trim().isEmpty()) {
      connection.setRequestProperty(name, value.trim());
    }
  }

  @PluginMethod
  public void importPackage(PluginCall call) {
    String bookId = call.getString("bookId");
    String filePath = call.getString("filePath");
    Integer expectedChapterCount = call.getInt("expectedChapterCount");

    if (bookId == null || filePath == null) {
      call.reject("Missing importPackage parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        try {
          File packageFile = new File(filePath);
          if (!packageFile.exists() || !packageFile.isFile()) {
            throw new IllegalStateException("Package file does not exist.");
          }

          long totalBytes = packageFile.length();
          long readBytes = 0;
          int summaryHints = 0;
          int graphHints = 0;
          int embeddingHints = 0;
          byte[] buffer = new byte[1024 * 256];
          String carry = "";
          long lastProgressAt = 0;

          notifyPackageProgress(bookId, "import", "indexing", 0, totalBytes);
          try (FileInputStream input = new FileInputStream(packageFile)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
              readBytes += read;
              String chunk = carry + new String(buffer, 0, read, StandardCharsets.UTF_8);
              summaryHints += estimateCount(chunk, "\"summaries\"") + estimateCount(chunk, "\"summary\"");
              graphHints += estimateCount(chunk, "\"knowledgeGraph\"") + estimateCount(chunk, "\"entityMentions\"") + estimateCount(chunk, "\"relationMentions\"");
              embeddingHints += estimateCount(chunk, "\"embeddings\"") + estimateCount(chunk, "\"vector\"");
              carry = chunk.length() > 256 ? chunk.substring(chunk.length() - 256) : chunk;
              if (readBytes - lastProgressAt >= 1024 * 1024 || readBytes == totalBytes) {
                lastProgressAt = readBytes;
                notifyPackageProgress(bookId, "import", "indexing", readBytes, totalBytes);
              }
            }
          }

          int chapterCount = expectedChapterCount == null || expectedChapterCount <= 0 ? 0 : expectedChapterCount;
          int summaryCount = chapterCount > 0 && summaryHints > 0 ? chapterCount : summaryHints;
          int entityMentionCount = graphHints > 0 && chapterCount > 0 ? chapterCount : graphHints;
          int embeddingChunkCount = embeddingHints > 0 && chapterCount > 0 ? chapterCount : embeddingHints;

          String importedAt = String.valueOf(System.currentTimeMillis());
          File importFile = new File(packageFile.getParentFile(), "package-import.json");
          String metadata = "{"
            + "\"bookId\":\"" + jsonEscape(bookId) + "\","
            + "\"filePath\":\"" + jsonEscape(packageFile.getAbsolutePath()) + "\","
            + "\"sizeBytes\":" + totalBytes + ","
            + "\"importedAt\":\"" + importedAt + "\","
            + "\"chapterCount\":" + chapterCount + ","
            + "\"summaryCount\":" + summaryCount + ","
            + "\"knowledgeGraph\":{\"entityCount\":" + entityMentionCount + ",\"entityMentionCount\":" + entityMentionCount + ",\"relationCount\":" + entityMentionCount + ",\"relationMentionCount\":" + entityMentionCount + "},"
            + "\"embeddings\":{\"summaryCount\":" + summaryCount + ",\"chunkCount\":" + embeddingChunkCount + "}"
            + "}";
          try (FileOutputStream output = new FileOutputStream(importFile, false)) {
            output.write(metadata.getBytes(StandardCharsets.UTF_8));
          }

          notifyPackageProgress(bookId, "import", "imported", totalBytes, totalBytes);
          JSObject result = new JSObject(metadata);
          result.put("metadataPath", importFile.getAbsolutePath());
          call.resolve(result);
        } catch (Exception error) {
          call.reject(error.getMessage() == null ? "Package import failed." : error.getMessage(), error);
        }
      }
    );
  }

  @PluginMethod
  public void clearAudioCache(PluginCall call) {
    String bookId = call.getString("bookId");
    if (bookId == null) {
      call.reject("Missing clearAudioCache parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        try {
          File bookDir = new File(getContext().getFilesDir(), "audio/" + safeSegment(bookId));
          long deletedBytes = deleteRecursively(bookDir);
          JSObject result = new JSObject();
          result.put("deletedBytes", deletedBytes);
          call.resolve(result);
        } catch (Exception error) {
          call.reject(error.getMessage() == null ? "Audio cache cleanup failed." : error.getMessage(), error);
        }
      }
    );
  }

  @PluginMethod
  public void clearPackageCache(PluginCall call) {
    String bookId = call.getString("bookId");
    if (bookId == null) {
      call.reject("Missing clearPackageCache parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        try {
          File bookDir = new File(getContext().getFilesDir(), "packages/" + safeSegment(bookId));
          long deletedBytes = deleteRecursively(bookDir);
          JSObject result = new JSObject();
          result.put("deletedBytes", deletedBytes);
          call.resolve(result);
        } catch (Exception error) {
          call.reject(error.getMessage() == null ? "Package cache cleanup failed." : error.getMessage(), error);
        }
      }
    );
  }

  private void notifyPackageProgress(String bookId, String phase, String status, long done, long total) {
    JSObject payload = new JSObject();
    payload.put("bookId", bookId);
    payload.put("phase", phase);
    payload.put("status", status);
    payload.put("done", done);
    payload.put("total", total);
    notifyListeners("packageSyncProgress", payload);
  }
  private int estimateCount(String text, String needle) {
    int count = 0;
    int index = 0;
    while ((index = text.indexOf(needle, index)) != -1) {
      count++;
      index += needle.length();
    }
    return count;
  }

  private String jsonEscape(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }

  private String safeSegment(String value) {
    return value.replaceAll("[^A-Za-z0-9._-]", "_");
  }

  private long deleteRecursively(File file) {
    if (file == null || !file.exists()) return 0;
    long deletedBytes = file.isFile() ? file.length() : 0;
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children != null) {
        for (File child : children) {
          deletedBytes += deleteRecursively(child);
        }
      }
    }
    if (!file.delete() && file.exists()) {
      throw new IllegalStateException("Unable to delete cache file: " + file.getAbsolutePath());
    }
    return deletedBytes;
  }
}
