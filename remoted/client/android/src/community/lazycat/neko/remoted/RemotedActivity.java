package community.lazycat.neko.remoted;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import com.longbridge.nsh.NshView;

public final class RemotedActivity extends Activity {
    private NshView view;
    private PlatformBridge bridge;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        view = new NshView(this);
        bridge = new PlatformBridge(this);
        PlatformBridge.attach(bridge);
        setContentView(view);
        view.runRustApp("nsh");
    }

    @Override protected void onResume() {
        super.onResume();
        if (bridge != null) bridge.lifecycle("resumed");
    }

    @Override protected void onPause() {
        if (bridge != null) bridge.pause();
        super.onPause();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        bridge.pickerResult(request, result, data);
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        bridge.permissionResult(request, results);
    }

    @Override protected void onDestroy() {
        if (bridge != null) bridge.destroy();
        if (view != null) view.destroy();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (view == null || !view.handleBack()) super.onBackPressed();
    }
}
