package com.gwaves.novelreader.gateway;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "GatewayAudio")
public class GatewayAudioPlugin extends Plugin {
  @PluginMethod
  public void downloadAudio(PluginCall call) {
    String url = call.getString("url");
    String token = call.getString("token");
    String deviceName = call.getString("deviceName", "Android Phone");
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
          tempFile = new File(bookDir, safeSegment(chapterId) + ".tmp");

          connection = (HttpURLConnection) new URL(url).openConnection();
          connection.setConnectTimeout(15000);
          connection.setReadTimeout(180000);
          connection.setRequestProperty("Authorization", "Bearer " + token);
          connection.setRequestProperty("X-Device-Name", deviceName);

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
    String deviceName = call.getString("deviceName", "Android Phone");
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
          connection.setRequestProperty("X-Device-Name", deviceName);

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
  public void importPackage(PluginCall call) {
    String bookId = call.getString("bookId");
    String filePath = call.getString("filePath");

    if (bookId == null || filePath == null) {
      call.reject("Missing importPackage parameters.");
      return;
    }

    getBridge().execute(
      () -> {
        try {
          notifyPackageProgress(bookId, "import", "parsing", 0, 4);
          File packageFile = new File(filePath);
          JSONObject root;
          root = new JSONObject(readUtf8File(packageFile));

          JSONObject stats = new JSONObject();
          stats.put("chapterCount", arrayLength(root.optJSONArray("chapters")));
          stats.put("summaryCount", arrayLength(root.optJSONArray("summaries")));
          notifyPackageProgress(bookId, "import", "summaries", 1, 4);

          JSONObject graph = root.optJSONObject("knowledgeGraph");
          JSONObject graphStats = new JSONObject();
          graphStats.put("entityCount", arrayLength(graph == null ? null : graph.optJSONArray("entities")));
          graphStats.put("entityMentionCount", arrayLength(graph == null ? null : graph.optJSONArray("entityMentions")));
          graphStats.put("relationCount", arrayLength(graph == null ? null : graph.optJSONArray("relations")));
          graphStats.put("relationMentionCount", arrayLength(graph == null ? null : graph.optJSONArray("relationMentions")));
          stats.put("knowledgeGraph", graphStats);
          notifyPackageProgress(bookId, "import", "knowledgeGraph", 2, 4);

          JSONObject embeddings = root.optJSONObject("embeddings");
          JSONObject embeddingStats = new JSONObject();
          embeddingStats.put("summaryCount", arrayLength(embeddings == null ? null : embeddings.optJSONArray("summaries")));
          embeddingStats.put("chunkCount", arrayLength(embeddings == null ? null : embeddings.optJSONArray("chunks")));
          stats.put("embeddings", embeddingStats);
          notifyPackageProgress(bookId, "import", "embeddings", 3, 4);

          stats.put("bookId", bookId);
          stats.put("filePath", packageFile.getAbsolutePath());
          stats.put("sizeBytes", packageFile.length());
          stats.put("importedAt", String.valueOf(System.currentTimeMillis()));

          File importFile = new File(packageFile.getParentFile(), "package-import.json");
          try (FileOutputStream output = new FileOutputStream(importFile, false)) {
            output.write(stats.toString().getBytes(StandardCharsets.UTF_8));
          }

          notifyPackageProgress(bookId, "import", "imported", 4, 4);
          JSObject result = new JSObject(stats.toString());
          result.put("metadataPath", importFile.getAbsolutePath());
          call.resolve(result);
        } catch (Exception error) {
          call.reject(error.getMessage() == null ? "Package import failed." : error.getMessage(), error);
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
    private String readUtf8File(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024 * 256];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }


  private int arrayLength(JSONArray array) {
    return array == null ? 0 : array.length();
  }

  private String safeSegment(String value) {
    return value.replaceAll("[^A-Za-z0-9._-]", "_");
  }
}
