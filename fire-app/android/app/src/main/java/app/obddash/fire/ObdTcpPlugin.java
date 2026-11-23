package app.obddash.fire;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import org.json.JSONObject;

/**
 * Raw TCP link to an ELM327 WiFi adapter (e.g. Veepeak at 192.168.0.10:35000).
 * The page sends a command, the plugin writes it with "\r" and returns everything
 * up to the adapter's ">" prompt. Calls run one at a time, in order.
 */
@CapacitorPlugin(name = "ObdTcp")
public class ObdTcpPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private final byte[] chunk = new byte[512];
    private String header;              // last ATSH sent through here (null = unknown)
    private long cmdCount, cmdNanos;    // for the "ms per request" figure

    // Stream mode: keep polling the same passes and push each result to the page.
    private volatile int streamId;      // 0 = no stream
    private JSArray streamPasses;
    private int streamTimeout, streamPass;
    private final AtomicInteger unacked = new AtomicInteger();

    @PluginMethod
    public void open(PluginCall call) {
        String host = call.getString("host", "192.168.0.10");
        int port = call.getInt("port", 35000);
        int timeout = call.getInt("timeout", 5000);
        io.execute(() -> {
            closeQuietly();
            try {
                Socket s = new Socket();
                bindToWifi(s);
                s.setTcpNoDelay(true);
                s.connect(new InetSocketAddress(host, port), timeout);
                socket = s;
                in = s.getInputStream();
                out = s.getOutputStream();
                call.resolve();
            } catch (Exception e) {
                closeQuietly();
                call.reject(describe(e, host, port));
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String cmd = call.getString("cmd", "");
        int timeout = call.getInt("timeout", 5000);
        io.execute(() -> {
            try {
                String reply = exchange(cmd, timeout);
                if (reply == null) {
                    call.reject("timeout", "TIMEOUT");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("reply", reply);
                call.resolve(ret);
            } catch (Exception e) {
                closeQuietly();
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /**
     * Several commands in one call: one trip between the page and the app per polling pass
     * instead of one per command (each trip waits for the screen's UI thread, which is slow
     * on Fire tablets). replies[i] is null when command i timed out.
     */
    @PluginMethod
    public void sendMany(PluginCall call) {
        JSArray cmds = call.getArray("cmds", new JSArray());
        int timeout = call.getInt("timeout", 5000);
        io.execute(() -> {
            try {
                JSArray replies = new JSArray();
                for (int i = 0; i < cmds.length(); i++) {
                    String reply = exchange(cmds.getString(i), timeout);
                    replies.put(reply == null ? JSONObject.NULL : reply);
                }
                JSObject ret = new JSObject();
                ret.put("replies", replies);
                call.resolve(ret);
            } catch (Exception e) {
                closeQuietly();
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /**
     * Start polling non-stop: passes is [[{h: header or "", c: command}, ...], ...]. Each pass's
     * replies go to the page as a "pass" event {id, i, replies, ms}; the passes repeat until
     * stopStream. The page acks each event so the app never runs more than 2 passes ahead.
     */
    @PluginMethod
    public void startStream(PluginCall call) {
        JSArray passes = call.getArray("passes", new JSArray());
        int id = call.getInt("id", 1);
        int timeout = call.getInt("timeout", 2000);
        io.execute(() -> {
            streamPasses = passes;
            streamTimeout = timeout;
            streamPass = 0;
            unacked.set(0);
            streamId = id;
            io.execute(this::streamStep);
            call.resolve();
        });
    }

    @PluginMethod
    public void stopStream(PluginCall call) {
        streamId = 0;
        io.execute(call::resolve);   // after the pass in progress
    }

    @PluginMethod
    public void ack(PluginCall call) {
        if (unacked.get() > 0) unacked.decrementAndGet();
        call.resolve();
    }

    private void streamStep() {
        int id = streamId;
        if (id == 0 || socket == null) return;
        if (unacked.get() >= 2) {   // the page is behind: give it a moment
            try { Thread.sleep(2); } catch (InterruptedException e) { return; }
            io.execute(this::streamStep);
            return;
        }
        try {
            org.json.JSONArray items = streamPasses.getJSONArray(streamPass);
            long n0 = cmdCount, t0 = cmdNanos;
            JSArray replies = new JSArray();
            for (int k = 0; k < items.length(); k++) {
                JSONObject it = items.getJSONObject(k);
                String h = it.optString("h", "");
                if (!h.isEmpty() && !h.equals(header)) exchange("ATSH" + h, streamTimeout);
                String reply = exchange(it.getString("c"), streamTimeout);
                replies.put(reply == null ? JSONObject.NULL : reply);
            }
            if (streamId != id) return;   // stopped meanwhile: drop it
            JSObject ev = new JSObject();
            ev.put("id", id);
            ev.put("i", streamPass);
            ev.put("replies", replies);
            ev.put("ms", cmdCount > n0 ? (cmdNanos - t0) / 1e6 / (cmdCount - n0) : 0);
            unacked.incrementAndGet();
            notifyListeners("pass", ev);
            streamPass = (streamPass + 1) % streamPasses.length();
            io.execute(this::streamStep);
        } catch (Exception e) {
            streamId = 0;
            closeQuietly();
            JSObject ev = new JSObject();
            ev.put("id", id);
            ev.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
            notifyListeners("pass", ev);
        }
    }

    /** Write one command, read up to the ">" prompt. null = no prompt within the timeout. */
    private String exchange(String cmd, int timeout) throws java.io.IOException {
        String reply = exchangeRaw(cmd, timeout);
        String up = cmd.toUpperCase();
        if (reply == null || up.equals("ATZ") || up.equals("ATWS") || up.equals("ATD")) header = null;
        else if (up.startsWith("ATSH")) header = reply.contains("?") ? null : up.substring(4);
        return reply;
    }

    private String exchangeRaw(String cmd, int timeout) throws java.io.IOException {
        if (socket == null) throw new java.io.IOException("not connected");
        long started = System.nanoTime();
        // Throw away anything left over from an earlier, timed-out command.
        while (in.available() > 0) {
            if (in.read(chunk, 0, Math.min(chunk.length, in.available())) < 0) break;
        }
        out.write((cmd + "\r").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        StringBuilder buf = new StringBuilder();
        long deadline = System.currentTimeMillis() + timeout;
        while (true) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) return null;
            socket.setSoTimeout((int) Math.max(1, left));
            int n;
            try {
                n = in.read(chunk);
            } catch (SocketTimeoutException e) {
                return null;
            }
            if (n < 0) throw new java.io.EOFException("the adapter closed the connection");
            for (int i = 0; i < n; i++) {
                byte b = chunk[i];
                if (b == '>') {
                    cmdCount++;
                    cmdNanos += System.nanoTime() - started;
                    return buf.toString();
                }
                if (b != 0) buf.append((char) (b & 0xFF));
            }
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        io.execute(() -> {
            closeQuietly();
            call.resolve();
        });
    }

    /** Write a text file (trip CSV) to the tablet's Download folder. */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "trip.csv").replaceAll("[^A-Za-z0-9._-]", "_");
        byte[] data = call.getString("text", "").getBytes(StandardCharsets.UTF_8);
        io.execute(() -> {
            try {
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver cr = getContext().getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, "text/csv");
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/OBD Dash");
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new java.io.IOException("couldn't create the file");
                    try (OutputStream os = cr.openOutputStream(uri)) {
                        os.write(data);
                    }
                    where = "Download/OBD Dash";
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "OBD Dash");
                    if (!dir.exists() && !dir.mkdirs()) {
                        dir = getContext().getExternalFilesDir(null);   // no storage permission: app's own folder
                    }
                    File f = new File(dir, name);
                    try (FileOutputStream os = new FileOutputStream(f)) {
                        os.write(data);
                    }
                    where = dir.getAbsolutePath();
                }
                JSObject ret = new JSObject();
                ret.put("path", where);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /**
     * The adapter's WiFi has no internet, so Android may prefer another network for new
     * connections. Pin the socket to the WiFi network so it always goes to the adapter.
     */
    private void bindToWifi(Socket s) {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    n.bindSocket(s);
                    return;
                }
            }
        } catch (Exception ignored) {
            // Not fatal: fall back to the default route.
        }
    }

    private String describe(Exception e, String host, int port) {
        String m = e.getMessage() != null ? e.getMessage() : e.toString();
        if (e instanceof SocketTimeoutException || m.contains("ETIMEDOUT") || m.contains("ENETUNREACH") || m.contains("EHOSTUNREACH")) {
            return "can't reach " + host + ":" + port + ". Is the tablet on the adapter's WiFi (e.g. V-LINK)?";
        }
        if (m.contains("ECONNREFUSED")) return host + ":" + port + " refused the connection. Check the port (Veepeak: 35000)";
        return m;
    }

    private void closeQuietly() {
        header = null;
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
        socket = null;
        in = null;
        out = null;
    }

    @Override
    protected void handleOnDestroy() {
        streamId = 0;
        closeQuietly();
        io.shutdownNow();
    }
}
