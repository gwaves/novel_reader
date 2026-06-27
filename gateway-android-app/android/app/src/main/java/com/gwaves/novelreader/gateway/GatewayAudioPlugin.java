package com.gwaves.novelreader.gateway;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

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
            throw new IllegalStateException("Unable to replace cached package file.");
          }
          if (!tempFile.renameTo(targetFile)) {
            throw new IllegalStateException("Unable to finish cached package file.");
          }

          JSObject result = new JSObject();
          result.put("filePath", targetFile.getAbsolutePath());
          result.put("sizeBytes", sizeBytes);
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

  private String safeSegment(String value) {
    return value.replaceAll("[^A-Za-z0-9._-]", "_");
  }
}
