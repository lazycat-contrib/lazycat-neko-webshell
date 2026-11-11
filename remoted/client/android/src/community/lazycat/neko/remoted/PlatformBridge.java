package community.lazycat.neko.remoted;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.provider.DocumentsContract;
import android.util.Base64;
import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class PlatformBridge {
    private static final int UPLOAD = 4101, DOWNLOAD = 4102, CAMERA = 4103;
    private final Activity activity;
    private final SecureStore store;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, Closeable> streams = new HashMap<>();
    private final Map<String, Uri> documents = new HashMap<>();
    private final Map<String, File> staged = new HashMap<>();
    private final java.util.Set<Long> pending = ConcurrentHashMap.newKeySet();
    private volatile boolean alive = true;
    private long pickerId, scannerId;
    private QrScanner scanner;

    PlatformBridge(Activity activity) { this.activity = activity; store = new SecureStore(activity); }
    private static native void nativeAttach(PlatformBridge bridge, String directory);
    private static native void nativeEvent(long id, String json);
    static void attach(PlatformBridge bridge) { nativeAttach(bridge, bridge.activity.getNoBackupFilesDir().getAbsolutePath()); }

    private boolean answer(long id, Object result, String error) {
        if (id != 0 && !pending.remove(id)) return false;
        JSONObject value = new JSONObject();
        try {
            if (error == null) value.put("result", result == null ? JSONObject.NULL : result);
            else value.put("error", error);
            nativeEvent(id, value.toString());
            return true;
        } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    public void cancel(long id) {
        pending.remove(id);
        activity.runOnUiThread(() -> {
            if (scannerId == id) finishScan(null, "Scanning cancelled");
            if (pickerId == id) {
                pickerId = 0;
                activity.finishActivity(UPLOAD);
                activity.finishActivity(DOWNLOAD);
            }
        });
    }

    public void request(String json, long id) {
        pending.add(id);
        if (!alive) { answer(id, null, "Activity destroyed"); return; }
        try {
            JSONObject request = new JSONObject(json);
            String operation = request.getString("op");
            if (operation.equals("scan") || operation.equals("pickUpload") || operation.equals("pickDownload")) {
                activity.runOnUiThread(() -> {
                    try {
                        if (!alive) throw new IllegalStateException("Activity destroyed");
                        if (!pending.contains(id)) return;
                        if (operation.equals("scan")) scan(id);
                        else pick(id, operation.equals("pickUpload"), request.optString("name", "download"));
                    } catch (Exception error) { answer(id, null, error.toString()); }
                });
            } else {
                worker.execute(() -> {
                    try {
                        if (!alive) throw new IllegalStateException("Activity destroyed");
                        if (!pending.contains(id)) return;
                        answer(id, perform(request), null);
                    } catch (Exception error) { answer(id, null, error.toString()); }
                });
            }
        } catch (Exception error) { answer(id, null, error.toString()); }
    }

    private Object perform(JSONObject request) throws Exception {
        switch (request.getString("op")) {
            case "secureGet": return store.get(request.getString("key"));
            case "secureSet": store.set(request.getString("key"), request.getString("value")); return true;
            case "read": {
                Closeable stream = streams.get(request.getString("handle"));
                if (!(stream instanceof InputStream)) throw new IllegalArgumentException("Unknown input stream");
                int size = request.optInt("size", 65536);
                if (size < 1 || size > 65536) throw new IllegalArgumentException("Chunk exceeds 64 KiB");
                byte[] bytes = new byte[size];
                int count = ((InputStream) stream).read(bytes);
                return new JSONObject().put("data", Base64.encodeToString(bytes, 0, Math.max(count, 0), Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING)).put("eof", count < 0);
            }
            case "write": {
                Closeable stream = streams.get(request.getString("handle"));
                if (!(stream instanceof OutputStream)) throw new IllegalArgumentException("Unknown output stream");
                String encoded = request.getString("data");
                if (encoded.length() > 87384) throw new IllegalArgumentException("Chunk exceeds 64 KiB");
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
                if (bytes.length > 65536) throw new IllegalArgumentException("Chunk exceeds 64 KiB");
                ((OutputStream) stream).write(bytes);
                return bytes.length;
            }
            case "close": {
                String handle = request.getString("handle");
                if (staged.containsKey(handle)) throw new IllegalArgumentException("Download requires commit or cancel");
                Closeable stream = streams.remove(handle);
                documents.remove(handle);
                if (stream == null) throw new IllegalArgumentException("Unknown stream");
                stream.close(); return true;
            }
            case "seek": {
                String handle = request.getString("handle");
                if (request.getLong("offset") != 0 || staged.containsKey(handle)) throw new IllegalArgumentException("Only input rewind to zero is supported");
                Closeable stream = streams.get(handle);
                Uri uri = documents.get(handle);
                if (!(stream instanceof InputStream) || uri == null) throw new IllegalArgumentException("Unknown input stream");
                InputStream reopened = activity.getContentResolver().openInputStream(uri);
                if (reopened == null) throw new java.io.IOException("Cannot reopen document");
                try { stream.close(); } catch (Exception error) { reopened.close(); throw error; }
                streams.put(handle, reopened); return true;
            }
            case "commit": {
                String handle = request.getString("handle");
                File file = staged.get(handle);
                if (file == null) throw new IllegalArgumentException("Unknown staged download");
                Closeable stream = streams.remove(handle);
                if (stream != null) stream.close();
                try (InputStream input = new FileInputStream(file);
                     OutputStream output = activity.getContentResolver().openOutputStream(documents.get(handle), "wt")) {
                    if (output == null) throw new java.io.IOException("Document provider refused save");
                    byte[] chunk = new byte[65536]; int count;
                    while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count);
                    output.flush();
                }
                if (!file.delete()) throw new java.io.IOException("Cannot remove staged download");
                staged.remove(handle); documents.remove(handle); return true;
            }
            case "cancel": {
                String handle = request.getString("handle");
                Closeable stream = streams.remove(handle);
                File file = staged.remove(handle);
                Uri uri = documents.remove(handle);
                if (stream == null && file == null && uri == null) throw new IllegalArgumentException("Unknown stream");
                Exception failure = null;
                try { if (stream != null) stream.close(); } catch (Exception error) { failure = error; }
                if (file != null) {
                    if (file.exists() && !file.delete()) failure = new java.io.IOException("Cannot remove staged download");
                    try { if (!DocumentsContract.deleteDocument(activity.getContentResolver(), uri)) throw new java.io.IOException("Provider did not confirm document deletion"); }
                    catch (Exception error) { failure = error; }
                }
                if (failure != null) throw failure;
                return true;
            }
            default: throw new IllegalArgumentException("Unknown platform operation");
        }
    }

    private void pick(long id, boolean upload, String name) {
        if (pickerId != 0 || scannerId != 0) { answer(id, null, "A system dialog is already open"); return; }
        Intent intent = new Intent(upload ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream");
        if (upload) intent.setType("*/*");
        else intent.putExtra(Intent.EXTRA_TITLE, name.replaceAll("[\\\\/\\p{Cntrl}]", "_"));
        pickerId = id;
        try { activity.startActivityForResult(intent, upload ? UPLOAD : DOWNLOAD); }
        catch (Exception error) { pickerId = 0; throw error; }
    }

    void pickerResult(int request, int result, Intent data) {
        if (request != UPLOAD && request != DOWNLOAD) return;
        long id = pickerId; pickerId = 0;
        if (id == 0) return;
        if (result != Activity.RESULT_OK || data == null || data.getData() == null) { answer(id, null, null); return; }
        Uri uri = data.getData();
        worker.execute(() -> {
            Closeable stream = null;
            try {
                if (!alive) throw new IllegalStateException("Activity destroyed");
                if (streams.size() >= 4) throw new IllegalStateException("Close an existing file stream first");
                String name = "file"; long size = -1;
                try (Cursor cursor = activity.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn);
                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn);
                    }
                }
                File file = request == DOWNLOAD ? File.createTempFile("remoted-download-", ".part", activity.getCacheDir()) : null;
                try { stream = request == UPLOAD ? activity.getContentResolver().openInputStream(uri) : new FileOutputStream(file); }
                catch (Exception error) { if (file != null) file.delete(); throw error; }
                if (stream == null) throw new java.io.IOException("Document provider refused stream");
                String handle = UUID.randomUUID().toString();
                JSONObject reply = new JSONObject().put("handle", handle).put("name", name).put("size", size);
                streams.put(handle, stream); stream = null;
                documents.put(handle, uri);
                if (file != null) staged.put(handle, file);
                if (!answer(id, reply, null)) perform(new JSONObject().put("op", "cancel").put("handle", handle));
            } catch (Exception error) { answer(id, null, error.toString()); }
            finally { if (stream != null) try { stream.close(); } catch (Exception ignored) {} }
        });
    }

    private void scan(long id) {
        if (scannerId != 0 || pickerId != 0) { answer(id, null, "A system dialog is already open"); return; }
        scannerId = id;
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA);
        else startScanner();
    }

    void permissionResult(int request, int[] results) {
        if (request != CAMERA || scannerId == 0) return;
        if (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED) finishScan(null, "Camera permission denied");
        else startScanner();
    }

    private void startScanner() {
        try {
            scanner = new QrScanner(activity, (code, error) -> finishScan(code, error));
            scanner.show();
        } catch (Exception error) { finishScan(null, error.toString()); }
    }

    private void finishScan(String code, String error) {
        long id = scannerId; scannerId = 0;
        QrScanner current = scanner; scanner = null;
        if (current != null) current.close();
        if (id != 0) answer(id, code, error);
    }

    void lifecycle(String state) {
        try { answer(0, new JSONObject().put("lifecycle", state), null); }
        catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    void pause() {
        if (scanner != null) finishScan(null, "Scanning interrupted; try again when the app resumes");
        lifecycle("paused");
    }

    void destroy() {
        alive = false;
        finishScan(null, "Activity destroyed");
        for (long id : pending) answer(id, null, "Activity destroyed");
        lifecycle("destroyed");
        worker.execute(() -> {
            for (Closeable stream : streams.values()) try { stream.close(); } catch (Exception ignored) {}
            for (Map.Entry<String, File> entry : staged.entrySet()) {
                entry.getValue().delete();
                try { DocumentsContract.deleteDocument(activity.getContentResolver(), documents.get(entry.getKey())); } catch (Exception ignored) {}
            }
            streams.clear();
            staged.clear(); documents.clear();
        });
        worker.shutdown();
    }
}
