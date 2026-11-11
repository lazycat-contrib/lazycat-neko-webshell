package community.lazycat.neko.remoted;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.util.Base64;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

public final class PlatformInstrumentation extends Instrumentation {
    private static final String PACKAGE = "community.lazycat.neko.remoted";
    private static final String AUTHORITY = PACKAGE + ".tests.documents";
    private Activity activity;
    private Object bridge;
    private ExecutorService worker;
    private final StringBuilder proof = new StringBuilder();

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    private void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private void passed(String message) { proof.append("PASS ").append(message).append('\n'); }
    private Field field(Object object, String name) throws Exception {
        Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field;
    }
    private Object invoke(Object object, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = object.getClass().getDeclaredMethod(name, types); method.setAccessible(true);
        try { return method.invoke(object, values); }
        catch (InvocationTargetException error) {
            if (error.getCause() instanceof Exception) throw (Exception) error.getCause();
            throw error;
        }
    }
    private Object perform(JSONObject request) throws Exception {
        return worker.submit(() -> invoke(bridge, "perform", new Class<?>[]{JSONObject.class}, request)).get(20, TimeUnit.SECONDS);
    }
    private Uri uri(String id) { return DocumentsContract.buildDocumentUri(AUTHORITY, id); }
    private String picked(boolean upload) throws Exception {
        long id = upload ? 900001 : 900002;
        field(bridge, "pickerId").setLong(bridge, id);
        ((Set<Long>) field(bridge, "pending").get(bridge)).add(id);
        Set<String> before = worker.submit(() -> new java.util.HashSet<>(((Map<String, ?>) field(bridge, "streams").get(bridge)).keySet())).get();
        Intent data = new Intent().setData(uri(upload ? "source" : "target"));
        runOnMainSync(() -> {
            try { invoke(bridge, "pickerResult", new Class<?>[]{int.class, int.class, Intent.class}, upload ? 4101 : 4102, Activity.RESULT_OK, data); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        return worker.submit(() -> {
            for (String handle : ((Map<String, ?>) field(bridge, "streams").get(bridge)).keySet()) if (!before.contains(handle)) return handle;
            throw new AssertionError("Picker returned no file handle");
        }).get(20, TimeUnit.SECONDS);
    }

    private void storage() throws Exception {
        Object store = field(bridge, "store").get(bridge);
        String name = "platform.instrumentation." + java.util.UUID.randomUUID();
        String value = "identity-binding-roundtrip-" + java.util.UUID.randomUUID();
        check(invoke(store, "get", new Class<?>[]{String.class}, name) == null, "Missing storage must return null");
        invoke(store, "set", new Class<?>[]{String.class, String.class}, name, value);
        check(value.equals(invoke(store, "get", new Class<?>[]{String.class}, name)), "Keystore roundtrip failed");
        java.lang.reflect.Constructor<?> constructor = store.getClass().getDeclaredConstructor(android.content.Context.class);
        constructor.setAccessible(true);
        Object reopened = constructor.newInstance(activity);
        check(value.equals(invoke(reopened, "get", new Class<?>[]{String.class}, name)), "Reopened Keystore store lost identity");
        android.util.AtomicFile atomic = (android.util.AtomicFile) invoke(store, "file", new Class<?>[]{String.class}, name);
        byte[] wrapped = atomic.readFully();
        check(!new String(wrapped, StandardCharsets.ISO_8859_1).contains(value), "Storage leaked plaintext");
        wrapped[wrapped.length - 1] ^= 1;
        try (OutputStream output = new java.io.FileOutputStream(atomic.getBaseFile())) { output.write(wrapped); }
        boolean rejected = false;
        try { invoke(store, "get", new Class<?>[]{String.class}, name); } catch (Exception expected) { rejected = true; }
        check(rejected, "Tampered GCM record was accepted");
        check(atomic.getBaseFile().exists(), "Tampered identity silently removed");
        atomic.delete();
        passed("Android Keystore AES-GCM roundtrip, no plaintext, tamper rejection and record retention");
    }

    private void saf() throws Exception {
        getTargetContext().startActivity(new Intent().setClassName(PACKAGE + ".tests", PACKAGE + ".FixtureGrantActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Thread.sleep(1000);
        byte[] payload = new byte[100003];
        for (int index = 0; index < payload.length; index++) payload[index] = (byte) (index * 31);
        try (OutputStream output = getTargetContext().getContentResolver().openOutputStream(uri("source"), "wt")) { output.write(payload); }
        String input = picked(true);
        try {
            perform(new JSONObject().put("op", "read").put("handle", input).put("size", 65537));
            throw new AssertionError("Oversized read was accepted");
        } catch (java.util.concurrent.ExecutionException expected) {}
        java.io.ByteArrayOutputStream received = new java.io.ByteArrayOutputStream();
        while (true) {
            JSONObject chunk = (JSONObject) perform(new JSONObject().put("op", "read").put("handle", input).put("size", 32768));
            received.write(Base64.decode(chunk.getString("data"), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
            if (chunk.getBoolean("eof")) break;
        }
        check(java.util.Arrays.equals(payload, received.toByteArray()), "SAF upload changed bytes");
        perform(new JSONObject().put("op", "seek").put("handle", input).put("offset", 0));
        JSONObject first = (JSONObject) perform(new JSONObject().put("op", "read").put("handle", input).put("size", 32768));
        check(Base64.decode(first.getString("data"), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING).length == 32768, "SAF rewind failed");
        perform(new JSONObject().put("op", "close").put("handle", input));
        passed("SAF provider upload 100003 bytes in 32KiB chunks, EOF, rewind and close");
        try (OutputStream output = getTargetContext().getContentResolver().openOutputStream(uri("target"), "wt")) {}
        String output = picked(false);
        for (int offset = 0; offset < payload.length; offset += 32768) {
            byte[] chunk = java.util.Arrays.copyOfRange(payload, offset, Math.min(payload.length, offset + 32768));
            perform(new JSONObject().put("op", "write").put("handle", output).put("data", Base64.encodeToString(chunk, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)));
        }
        try (InputStream untouched = getTargetContext().getContentResolver().openInputStream(uri("target"))) { check(untouched.read() == -1, "SAF destination changed before commit"); }
        perform(new JSONObject().put("op", "commit").put("handle", output));
        try (InputStream saved = getTargetContext().getContentResolver().openInputStream(uri("target"))) {
            received.reset(); byte[] bytes = new byte[32768]; int count;
            while ((count = saved.read(bytes)) != -1) received.write(bytes, 0, count);
        }
        check(java.util.Arrays.equals(payload, received.toByteArray()), "SAF commit changed bytes");
        output = picked(false);
        perform(new JSONObject().put("op", "cancel").put("handle", output));
        boolean removed = false;
        try (InputStream deleted = getTargetContext().getContentResolver().openInputStream(uri("target"))) { removed = deleted == null; }
        catch (java.io.FileNotFoundException expected) { removed = true; }
        catch (SecurityException revokedAfterDeletion) { removed = true; }
        check(removed, "Cancelled SAF document survived");
        passed("SAF download staging, destination unchanged before commit, verified bytes and cancellation deletion");
    }

    private void camera() throws Exception {
        getUiAutomation().grantRuntimePermission(PACKAGE, android.Manifest.permission.CAMERA);
        check(getTargetContext().checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED, "Camera grant failed");
        Method request = bridge.getClass().getMethod("request", String.class, long.class);
        request.invoke(bridge, "{\"op\":\"scan\"}", 900003L);
        Thread.sleep(1500);
        Object scanner = field(bridge, "scanner").get(bridge);
        check(scanner != null, "Camera scanner did not open");
        check(field(scanner, "camera").get(scanner) != null, "Live camera preview not running");
        bridge.getClass().getMethod("cancel", long.class).invoke(bridge, 900003L);
        waitForIdleSync();
        check(field(bridge, "scanner").get(bridge) == null, "Camera not released after cancellation");
        runOnMainSync(() -> {
            try {
                field(bridge, "scannerId").setLong(bridge, 900004L);
                ((Set<Long>) field(bridge, "pending").get(bridge)).add(900004L);
                invoke(bridge, "permissionResult", new Class<?>[]{int.class, int[].class}, 4103, new int[]{PackageManager.PERMISSION_DENIED});
            } catch (Exception error) { throw new RuntimeException(error); }
        });
        check(field(bridge, "scannerId").getLong(bridge) == 0, "Denied permission left scanner pending");
        passed("Runtime camera permission grant, actual live camera preview, cancel/release and denied-result handling");
    }

    private void pickerCancellation() throws Exception {
        bridge.getClass().getMethod("request", String.class, long.class).invoke(bridge, "{\"op\":\"pickUpload\"}", 900005L);
        Thread.sleep(1000);
        check(field(bridge, "pickerId").getLong(bridge) == 900005L, "System picker did not launch");
        try (android.os.ParcelFileDescriptor command = getUiAutomation().executeShellCommand("input keyevent 4");
             InputStream completion = new android.os.ParcelFileDescriptor.AutoCloseInputStream(command)) {
            while (completion.read() != -1) {}
        }
        for (int attempt = 0; attempt < 30 && field(bridge, "pickerId").getLong(bridge) != 0; attempt++) Thread.sleep(100);
        check(field(bridge, "pickerId").getLong(bridge) == 0, "System picker cancellation left pending request");
        passed("Actual Android SAF picker launch and Back cancellation");
    }

    private android.widget.Toolbar toolbar(android.view.View view) {
        if (view instanceof android.widget.Toolbar) return (android.widget.Toolbar) view;
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                android.widget.Toolbar found = toolbar(group.getChildAt(index));
                if (found != null) return found;
            }
        }
        return null;
    }

    private void theme() throws Exception {
        boolean night = (activity.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        android.util.TypedValue light = new android.util.TypedValue();
        check(activity.getTheme().resolveAttribute(android.R.attr.isLightTheme, light, true), "Host theme has no light/dark attribute");
        check((light.data != 0) != night, "Host theme disagrees with system appearance");
        runOnMainSync(() -> {
            android.widget.Toolbar header = toolbar(activity.getWindow().getDecorView());
            check(header != null, "Native NSH header missing");
            check(header.getBackground() instanceof android.graphics.drawable.ColorDrawable, "Native header background is not inspectable");
            android.util.TypedValue background = new android.util.TypedValue();
            check(activity.getTheme().resolveAttribute(android.R.attr.colorBackground, background, true), "Host background attribute missing");
            int actual = ((android.graphics.drawable.ColorDrawable) header.getBackground()).getColor();
            check(actual == background.data, "Native NSH header did not apply the current host theme");
        });
        passed("System appearance matches app-owned host theme and actual native NSH header background");
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent launch = new Intent().setClassName(PACKAGE, PACKAGE + ".RemotedActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(launch);
            waitForIdleSync();
            check(!activity.isFinishing(), "Activity finished during launch");
            bridge = field(activity, "bridge").get(activity);
            worker = (ExecutorService) field(bridge, "worker").get(bridge);
            Object view = field(activity, "view").get(activity);
            check(view.getClass().getName().equals("com.longbridge.nsh.NshView"), "Activity does not host NshView");
            passed("Real RemotedActivity created, JNI attached and actual NshView hosted");
            storage(); saf(); pickerCancellation(); camera(); theme();
            runOnMainSync(() -> { callActivityOnPause(activity); callActivityOnResume(activity); });
            passed("Activity pause/resume lifecycle callbacks");
            runOnMainSync(() -> activity.finish());
            for (int attempt = 0; attempt < 30 && field(bridge, "alive").getBoolean(bridge); attempt++) Thread.sleep(100);
            check(!field(bridge, "alive").getBoolean(bridge), "Activity destroy did not detach platform");
            check(worker.isShutdown(), "Activity destroy did not stop worker");
            passed("Actual Activity destruction detaches JNI platform and shuts down worker");
            result.putString("stream", proof.toString());
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", proof + "FAIL " + android.util.Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
