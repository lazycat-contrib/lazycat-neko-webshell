package community.lazycat.neko.remoted;

import android.app.Activity;
import android.app.Dialog;
import android.hardware.Camera;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@SuppressWarnings("deprecation")
final class QrScanner implements SurfaceHolder.Callback {
    interface Result { void complete(String value, String error); }
    private final Activity activity;
    private final Result result;
    private final Dialog dialog;
    private final SurfaceView preview;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean();
    private volatile boolean closed;
    private Camera camera;

    QrScanner(Activity activity, Result result) {
        this.activity = activity;
        this.result = result;
        dialog = new Dialog(activity);
        dialog.setTitle("扫描设备二维码");
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        TextView instruction = new TextView(activity);
        instruction.setText("将设备二维码放在取景框中");
        instruction.setPadding(24, 24, 24, 24);
        layout.addView(instruction);
        preview = new SurfaceView(activity);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        Button cancel = new Button(activity);
        cancel.setText(android.R.string.cancel);
        cancel.setOnClickListener(view -> result.complete(null, "Scanning cancelled"));
        layout.addView(cancel);
        dialog.setContentView(layout);
        dialog.setOnCancelListener(ignored -> result.complete(null, "Scanning cancelled"));
        preview.getHolder().addCallback(this);
    }

    void show() {
        dialog.show();
        dialog.getWindow().setLayout(-1, -1);
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        if (closed) return;
        try {
            int selected = -1;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int index = 0; index < Camera.getNumberOfCameras(); index++) {
                Camera.getCameraInfo(index, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { selected = index; break; }
            }
            if (selected < 0 && Camera.getNumberOfCameras() > 0) selected = 0;
            if (selected < 0) throw new IllegalStateException("No camera available");
            Camera.getCameraInfo(selected, info);
            camera = Camera.open(selected);
            Camera.Parameters parameters = camera.getParameters();
            Camera.Size chosen = null;
            for (Camera.Size size : parameters.getSupportedPreviewSizes())
                if (size.width * size.height <= 1280 * 720 && (chosen == null || size.width * size.height > chosen.width * chosen.height)) chosen = size;
            if (chosen == null) throw new IllegalStateException("Camera has no preview mode at or below 720p");
            parameters.setPreviewSize(chosen.width, chosen.height);
            parameters.setPreviewFormat(android.graphics.ImageFormat.NV21);
            if (parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE))
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(parameters);
            int display = activity.getWindowManager().getDefaultDisplay().getRotation();
            int rotation = display == Surface.ROTATION_90 ? 90 : display == Surface.ROTATION_180 ? 180 : display == Surface.ROTATION_270 ? 270 : 0;
            int orientation = info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT
                ? (360 - (info.orientation + rotation) % 360) % 360 : (info.orientation - rotation + 360) % 360;
            camera.setDisplayOrientation(orientation);
            camera.setPreviewDisplay(holder);
            Camera.Size size = parameters.getPreviewSize();
            camera.setPreviewCallback((bytes, source) -> {
                if (closed || !decoding.compareAndSet(false, true)) return;
                byte[] luminance = java.util.Arrays.copyOf(bytes, size.width * size.height);
                decoder.execute(() -> decode(luminance, size.width, size.height));
            });
            camera.startPreview();
        } catch (Exception error) { result.complete(null, "Camera unavailable: " + error); }
    }

    private void decode(byte[] frame, int width, int height) {
        try {
            String text = decodeFrame(frame, width, height);
            if (text.length() > 8192) throw new IllegalArgumentException("QR payload exceeds 8 KiB");
            activity.runOnUiThread(() -> { if (!closed) result.complete(text, null); });
        } catch (com.google.zxing.ReaderException unreadable) {
        } catch (Exception error) {
            activity.runOnUiThread(() -> { if (!closed) result.complete(null, error.toString()); });
        } finally { decoding.set(false); }
    }

    static String decodeFrame(byte[] frame, int width, int height) throws com.google.zxing.ReaderException {
        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(frame, width, height, 0, 0, width, height, false);
        return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)),
            Collections.singletonMap(DecodeHintType.TRY_HARDER, Boolean.TRUE)).getText();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
    @Override public void surfaceDestroyed(SurfaceHolder holder) { releaseCamera(); }

    private void releaseCamera() {
        if (camera == null) return;
        camera.setPreviewCallback(null);
        camera.stopPreview();
        camera.release();
        camera = null;
    }

    void close() {
        closed = true;
        releaseCamera();
        decoder.shutdownNow();
        dialog.dismiss();
    }
}
