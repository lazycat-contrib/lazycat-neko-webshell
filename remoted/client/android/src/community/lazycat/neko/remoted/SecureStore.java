package community.lazycat.neko.remoted;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureStore {
    private static final String ALIAS = "community.lazycat.neko.remoted.storage.v1";
    private final File directory;

    SecureStore(Context context) {
        directory = new File(context.getNoBackupFilesDir(), "wrapped");
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (directory.exists() && directory.list() != null && directory.list().length > 0)
            throw new IllegalStateException("Storage key unavailable; encrypted identity was retained");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private AtomicFile file(String name) throws Exception {
        if (name.isEmpty() || name.length() > 128) throw new IllegalArgumentException("Invalid storage key");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(name.getBytes(StandardCharsets.UTF_8));
        StringBuilder encoded = new StringBuilder();
        for (byte value : digest) encoded.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return new AtomicFile(new File(directory, encoded.toString()));
    }

    synchronized String get(String name) throws Exception {
        AtomicFile file = file(name);
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) return null;
        if (file.getBaseFile().length() > 1024 * 1024 + 29) throw new IllegalStateException("Encrypted storage record exceeds limit");
        byte[] wrapped = file.readFully();
        if (wrapped.length < 29 || wrapped.length > 1024 * 1024 + 29 || wrapped[0] != 1)
            throw new IllegalStateException("Invalid encrypted storage record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(wrapped, 1, 13)));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(wrapped, 13, wrapped.length - 13), StandardCharsets.UTF_8);
    }

    synchronized void set(String name, String value) throws Exception {
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        if (plain.length > 1024 * 1024) throw new IllegalArgumentException("Storage record exceeds 1 MiB");
        SecretKey secret = key();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("Cannot create storage directory");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secret);
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(plain);
        AtomicFile file = file(name);
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(1);
            output.write(cipher.getIV());
            output.write(encrypted);
            file.finishWrite(output);
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            throw error;
        } finally {
            Arrays.fill(plain, (byte) 0);
        }
    }
}
