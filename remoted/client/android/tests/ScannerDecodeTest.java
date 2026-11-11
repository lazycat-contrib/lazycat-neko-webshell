package community.lazycat.neko.remoted;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;

public final class ScannerDecodeTest {
    // Synthetic public test vector, never a live pairing code. Matches protocol/code.rs:
    // route = SHA256([1; 32]), PSK = [2; 32], canonical RelayAddress below,
    // relay digest = SHA256(origin)[..8], checksum = SHA256(NR1 body)[..5].
    private static final String DEVICE_CODE = "NR1.cs1uhCLEB_ttCYaQ8RMLfe1-wvf14dML2dUh8BU2N5M.AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI.hwe5T1SNOC0.OxbEcvA";

    public static void main(String[] args) throws Exception {
        byte[] routeSecret = new byte[32];
        Arrays.fill(routeSecret, (byte) 1);
        byte[] psk = new byte[32];
        Arrays.fill(psk, (byte) 2);
        String body = "NR1." + encode(sha256(routeSecret)) + "." + encode(psk) + "."
                + encode(Arrays.copyOf(sha256("wss://relay.example.org".getBytes(StandardCharsets.UTF_8)), 8));
        String code = body + "." + encode(Arrays.copyOf(sha256(body.getBytes(StandardCharsets.UTF_8)), 5));
        if (!DEVICE_CODE.equals(code)) throw new AssertionError("NR1 test vector changed");
        assertFrames(DEVICE_CODE);
        // Decoder-only UTF-8 coverage; this text is deliberately not an accepted DeviceCode.
        assertFrames("扫码测试 · neko 🐈");
        try {
            QrScanner.decodeFrame(new byte[512 * 512], 512, 512);
            throw new AssertionError("Blank image decoded");
        } catch (com.google.zxing.NotFoundException expected) {}
        System.out.println("ScannerDecodeTest: canonical NR1 and Unicode normal/rotated, blank-frame checks passed");
    }

    private static byte[] sha256(byte[] bytes) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }

    private static String encode(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void assertFrames(String payload) throws Exception {
        BitMatrix qr = new QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 512, 512,
                Collections.singletonMap(EncodeHintType.CHARACTER_SET, "UTF-8"));
        byte[] luminance = new byte[512 * 512];
        for (int row = 0; row < 512; row++)
            for (int column = 0; column < 512; column++)
                luminance[row * 512 + column] = (byte) (qr.get(column, row) ? 0 : 255);
        if (!payload.equals(QrScanner.decodeFrame(luminance, 512, 512))) throw new AssertionError("QR payload changed");
        byte[] rotated = new byte[luminance.length];
        for (int row = 0; row < 512; row++)
            for (int column = 0; column < 512; column++) rotated[column * 512 + 511 - row] = luminance[row * 512 + column];
        if (!payload.equals(QrScanner.decodeFrame(rotated, 512, 512))) throw new AssertionError("Rotated QR failed");
    }
}
