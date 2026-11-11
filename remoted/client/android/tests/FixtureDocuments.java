package community.lazycat.neko.remoted;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;

public final class FixtureDocuments extends DocumentsProvider {
    @Override public boolean onCreate() { return true; }
    private File file(String id) throws FileNotFoundException {
        if (!id.equals("source") && !id.equals("target")) throw new FileNotFoundException("Unknown fixture document");
        return new File(getContext().getFilesDir(), id + ".bin");
    }
    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(new String[]{DocumentsContract.Root.COLUMN_ROOT_ID, DocumentsContract.Root.COLUMN_DOCUMENT_ID, DocumentsContract.Root.COLUMN_TITLE, DocumentsContract.Root.COLUMN_FLAGS});
        cursor.addRow(new Object[]{"fixtures", "source", "Remoted test documents", 0});
        return cursor;
    }
    @Override public Cursor queryDocument(String id, String[] projection) throws FileNotFoundException {
        File file = file(id);
        MatrixCursor cursor = new MatrixCursor(new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS});
        cursor.addRow(new Object[]{id, id + ".bin", file.length(), "application/octet-stream", DocumentsContract.Document.FLAG_SUPPORTS_WRITE | DocumentsContract.Document.FLAG_SUPPORTS_DELETE});
        return cursor;
    }
    @Override public Cursor queryChildDocuments(String parent, String[] projection, String sortOrder) throws FileNotFoundException { return queryDocument("source", projection); }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(id), ParcelFileDescriptor.parseMode(mode));
    }
    @Override public void deleteDocument(String id) throws FileNotFoundException {
        File file = file(id);
        if (file.exists() && !file.delete()) throw new FileNotFoundException("Cannot delete fixture");
    }
}
