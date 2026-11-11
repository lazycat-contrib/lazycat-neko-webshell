package community.lazycat.neko.remoted;

public final class FixtureGrantActivity extends android.app.Activity {
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        for (String id : new String[]{"source", "target"}) {
            android.net.Uri uri = android.provider.DocumentsContract.buildDocumentUri("community.lazycat.neko.remoted.tests.documents", id);
            grantUriPermission("community.lazycat.neko.remoted", uri,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        }
        finish();
    }
}
