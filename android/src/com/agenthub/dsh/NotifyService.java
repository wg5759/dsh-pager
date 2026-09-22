package com.agenthub.dsh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Background alerts: keeps one quiet connection to /m/api/notify on the home
 * PC and posts a notification when a task finishes, fails, or needs the
 * user's approval / answer. Approvals can be answered from the notification.
 *
 * The stream carries a handful of frames per task plus a heartbeat every 120 s,
 * so the radio mostly sleeps. A foreground service keeps the process (and its
 * network access) alive while the phone dozes.
 */
public class NotifyService extends Service {
    static final String ACTION_ALLOW = "com.agenthub.dsh.ALLOW";
    static final String ACTION_DENY = "com.agenthub.dsh.DENY";
    static final String ACTION_RECONNECT = "com.agenthub.dsh.RECONNECT";
    /** Pick one option of a question, straight from the notification. */
    static final String ACTION_ANSWER = "com.agenthub.dsh.ANSWER";
    /** Type the answer to a question (RemoteInput). */
    static final String ACTION_ANSWER_TEXT = "com.agenthub.dsh.ANSWER_TEXT";
    /** Type the next instruction under a "done" notice (RemoteInput). */
    static final String ACTION_REPLY = "com.agenthub.dsh.REPLY";
    static final String KEY_TEXT = "text";
    static final String CH_ALERT = "alert";
    static final String CH_DONE = "done";
    static final String CH_BG = "bg";
    static final int ID_BG = 1;
    static final int ID_LOGIN = 2;
    /** `adb logcat -s DSHNotify` — connection state and frame types only, never the cookie or content. */
    static final String TAG = "DSHNotify";

    /** True while MainActivity is on screen: finished-task notices are redundant then. */
    static volatile boolean appVisible;

    private volatile boolean running;
    private volatile HttpURLConnection live;
    private volatile boolean loginNotified;
    private Thread worker;
    private SharedPreferences prefs;
    private NotificationManager nm;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback netCb;
    private Network lastNet;
    private final Set<String> alerted = new HashSet<>();

    static void start(Context c) {
        try {
            c.startForegroundService(new Intent(c, NotifyService.class));
        } catch (Exception ignored) {
            // background-start restrictions: the next app launch starts it
        }
    }

    /** The server changed: drop the current stream and connect to the new one. */
    static void reconnect(Context c) {
        try {
            c.startForegroundService(new Intent(c, NotifyService.class).setAction(ACTION_RECONNECT));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("dsh", MODE_PRIVATE);
        nm = getSystemService(NotificationManager.class);
        channels();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_BG, keepalive(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID_BG, keepalive());
        running = true;
        worker = new Thread(this::loop, "dsh-notify");
        worker.start();
        // A new default network (Wi-Fi <-> mobile) silently kills the old TCP
        // connection; reconnect at once instead of waiting for the read timeout.
        cm = getSystemService(ConnectivityManager.class);
        netCb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                Network prev = lastNet;
                lastNet = n;
                if (prev != null && !prev.equals(n)) {
                    Log.i(TAG, "default network changed, reconnecting");
                    kick();
                }
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCb);
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent i, int flags, int startId) {
        String a = i == null ? null : i.getAction();
        final Intent in = i;
        if (ACTION_ALLOW.equals(a) || ACTION_DENY.equals(a)) {
            new Thread(() -> answer(in), "dsh-answer").start();
        } else if (ACTION_ANSWER.equals(a) || ACTION_ANSWER_TEXT.equals(a)) {
            new Thread(() -> answerQuestion(in), "dsh-answer").start();
        } else if (ACTION_REPLY.equals(a)) {
            new Thread(() -> reply(in), "dsh-reply").start();
        } else if (ACTION_RECONNECT.equals(a)) {
            alerted.clear();
            kick();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        kick();
        try {
            cm.unregisterNetworkCallback(netCb);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) {
        return null;
    }

    private void kick() {
        HttpURLConnection c = live;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
    }

    // ------------------------------------------------------------------ stream

    private void loop() {
        long backoff = 3000;
        while (running) {
            String base = MainActivity.server(this);
            if (base.isEmpty()) { // not set up yet
                nap(60000);
                continue;
            }
            try {
                stream(base, prefs.getString("cookie", ""));
                backoff = 3000;
                Log.i(TAG, "stream ended by server");
            } catch (LoginRequired e) {
                Log.w(TAG, "login required");
                if (!loginNotified) {
                    loginNotified = true;
                    simple(ID_LOGIN, CH_ALERT, "DSH 需要重新登录", "登录已过期，点开 App 登录一次即可恢复提醒", null);
                }
                nap(10 * 60000);
                continue;
            } catch (Exception e) {
                // offline, home PC down, or DSH restarting: retry with backoff
                Log.w(TAG, "stream failed: " + e.getClass().getSimpleName() + ": " + e.getMessage() + " (retry in " + backoff / 1000 + "s)");
            }
            nap(backoff);
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    private void stream(String base, String cookie) throws Exception {
        String epoch = prefs.getString("epoch", "");
        long since = prefs.getLong("n", -1);
        URL u = new URL(base + "/m/api/notify?hb=120&since=" + since + "&epoch=" + URLEncoder.encode(epoch, "UTF-8"));
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        live = c;
        try {
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(310000); // two missed heartbeats = dead link
            if (!cookie.isEmpty()) c.setRequestProperty("Cookie", cookie); // an auth gateway's session, if any
            c.setRequestProperty("Accept", "text/event-stream");
            int code = c.getResponseCode();
            Log.i(TAG, "connect since=" + since + " -> HTTP " + code);
            if (code == 401 || (code >= 300 && code < 400)) throw new LoginRequired();
            if (code != 200) throw new IOException("HTTP " + code);
            if (loginNotified) {
                loginNotified = false;
                nm.cancel(ID_LOGIN);
            }
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = r.readLine()) != null) {
                if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                } else if (line.isEmpty() && data.length() > 0) {
                    try {
                        onFrame(new JSONObject(data.toString()));
                    } catch (Exception ignored) {
                    }
                    data.setLength(0);
                }
            }
        } finally {
            live = null;
            c.disconnect();
        }
    }

    private void onFrame(JSONObject f) {
        String t = f.optString("t");
        Log.i(TAG, "frame " + t + (f.has("n") ? " n=" + f.optLong("n") : "") + (appVisible ? " (app visible)" : ""));
        if ("hello".equals(t)) {
            String ep = f.optString("epoch");
            if (!ep.equals(prefs.getString("epoch", ""))) prefs.edit().putString("epoch", ep).putLong("n", -1).apply();
            return;
        }
        long n = f.optLong("n", -1);
        if (n > prefs.getLong("n", -1)) prefs.edit().putLong("n", n).apply();
        switch (t) {
            case "ask":
                if (alerted.add("a:" + f.optString("id")) || !f.optBoolean("replay")) postAsk(f);
                break;
            case "askDone":
                nm.cancel(idFor("a:" + f.optString("id")));
                break;
            case "q":
                if (alerted.add("q:" + f.optString("rpc")) || !f.optBoolean("replay")) postQuestion(f);
                break;
            case "qDone":
                nm.cancel(idFor("q:" + f.optString("rpc")));
                break;
            case "done":
                if (!appVisible) postDone(f);
                break;
            case "err":
                if (!appVisible) postError(f);
                break;
            case "info": // e.g. Claude Code waiting at the PC for a dialog the phone could not take
                if (!appVisible) simple(idFor("i:" + f.optString("s")), CH_ALERT, f.optString("title"), f.optString("text"), f.optString("s"));
                break;
            default:
                break;
        }
    }

    // ------------------------------------------------------------------ notifications

    private void channels() {
        NotificationChannel alert = new NotificationChannel(CH_ALERT, "需要确认", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("DSH 等你允许操作或回答问题时提醒");
        alert.enableVibration(true);
        NotificationChannel done = new NotificationChannel(CH_DONE, "任务完成", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("任务做完或出错时提醒");
        NotificationChannel bg = new NotificationChannel(CH_BG, "后台连接", NotificationManager.IMPORTANCE_MIN);
        bg.setDescription("保持与家里电脑的连接");
        bg.setShowBadge(false);
        nm.createNotificationChannels(Arrays.asList(alert, done, bg));
    }

    private Notification keepalive() {
        return new Notification.Builder(this, CH_BG)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("DSH 在后台守候")
                .setContentText("任务完成或需要你确认时会提醒")
                .setContentIntent(open(null, ID_BG))
                .setOngoing(true)
                .setShowWhen(false)
                .build();
    }

    private Notification.Builder base(String channel, String title, String text, String session, int nid) {
        return new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF4D6BFE)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open(session, nid))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true);
    }

    private void postAsk(JSONObject f) {
        int nid = idFor("a:" + f.optString("id"));
        String what = f.optString("what", f.optString("tool"));
        String detail = f.optString("detail", "");
        String text = what + (detail.isEmpty() || detail.equals(what) ? "" : "\n" + clip(detail, 300));
        // Allowing makes the PC act: the phone must be unlocked first. Denying is always safe.
        Notification.Builder b = base(CH_ALERT, "需要你确认 · " + f.optString("title"), text, f.optString("s"), nid)
                .setCategory(Notification.CATEGORY_REMINDER)
                .addAction(action("拒绝", act(ACTION_DENY, f, nid), false, null))
                .addAction(action("允许", act(ACTION_ALLOW, f, nid), true, null));
        nm.notify(nid, b.build());
    }

    private void postQuestion(JSONObject f) {
        int nid = idFor("q:" + f.optString("rpc"));
        int count = f.optInt("count", 1);
        String text = f.optString("text") + (count > 1 ? "（共 " + count + " 个问题）" : "");
        Notification.Builder b = base(CH_ALERT, "DSH 在问你 · " + f.optString("title"), text, f.optString("s"), nid)
                .setCategory(Notification.CATEGORY_REMINDER);
        JSONArray opts = f.optJSONArray("opts");
        if (opts != null && opts.length() > 0) {
            // One single-choice question: its options become buttons (Android shows at most three).
            for (int k = 0; k < opts.length() && k < 3; k++) {
                String label = opts.optString(k);
                b.addAction(action(clip(label, 20), input(ACTION_ANSWER, f, nid, k + 1).putExtra("label", label), true, null));
            }
        } else if (count == 1) {
            b.addAction(action("回复", input(ACTION_ANSWER_TEXT, f, nid, 4), true, "输入你的回答"));
        }
        nm.notify(nid, b.build());
    }

    private void postDone(JSONObject f) {
        String s = f.optString("s");
        int nid = idFor("d:" + s);
        long ms = f.optLong("ms", 0);
        String preview = f.optString("preview", "");
        String text = (ms > 0 ? "已完成 · " + dur(ms) : "已完成") + (preview.isEmpty() ? "" : "\n" + preview);
        nm.notify(nid, base(CH_DONE, f.optString("title"), text, s, nid).setCategory(Notification.CATEGORY_STATUS)
                .addAction(action("回复", input(ACTION_REPLY, f, nid, 5), true, "接着让它做什么")).build());
    }

    /**
     * A notification button. `unlock`: Android 12+ asks to unlock the phone before
     * running it. `hint`: a text-input button (RemoteInput) with this placeholder.
     */
    private Notification.Action action(String title, Intent target, boolean unlock, String hint) {
        boolean typed = hint != null;
        PendingIntent pi = unlock ? confirm(target, typed) : service(target, typed);
        Notification.Action.Builder b = new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat), title, pi);
        if (typed) b.addRemoteInput(new RemoteInput.Builder(KEY_TEXT).setLabel(hint).build());
        return b.build();
    }

    /** The service intent behind an answer / reply button; `slot` keeps request codes distinct per button. */
    private Intent input(String action, JSONObject f, int nid, int slot) {
        return new Intent(this, NotifyService.class)
                .setAction(action)
                .putExtra("rpc", f.optString("rpc"))
                .putExtra("s", f.optString("s"))
                .putExtra("qid", f.optString("qid"))
                .putExtra("title", f.optString("title"))
                .putExtra("nid", nid)
                .putExtra("slot", slot);
    }

    /** Distinct request code per notification button, so PendingIntents do not overwrite each other. */
    private static int reqCode(Intent i) {
        return i.getIntExtra("nid", 0) * 8 + i.getIntExtra("slot", 0) + (ACTION_ALLOW.equals(i.getAction()) ? 1 : 0);
    }

    /** Fire the action straight away (no unlock needed, e.g. Deny). */
    private PendingIntent service(Intent i, boolean typed) {
        // A RemoteInput button must be mutable: the system adds the typed text to it.
        int mut = typed ? (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0) : PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getForegroundService(this, reqCode(i), i, mut | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * Require the phone to be unlocked first, then run the action. Goes through
     * ConfirmActivity (KeyguardManager.requestDismissKeyguard) rather than
     * Notification.Action.setAuthenticationRequired, whose unlock-then-fire flow
     * is not delivered on some OEM builds (HarmonyOS).
     */
    private PendingIntent confirm(Intent target, boolean typed) {
        Intent i = new Intent(this, ConfirmActivity.class)
                .setAction(target.getAction()) // a distinct intent identity per button
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra("fwd", target.getAction());
        if (target.getExtras() != null) i.putExtras(target.getExtras());
        int mut = typed ? (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0) : PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, reqCode(target), i, mut | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String typed(Intent in) {
        Bundle r = RemoteInput.getResultsFromIntent(in);
        CharSequence t = r == null ? null : r.getCharSequence(KEY_TEXT);
        return t == null ? "" : t.toString().trim();
    }

    private void postError(JSONObject f) {
        String s = f.optString("s");
        int nid = idFor("d:" + s);
        nm.notify(nid, base(CH_DONE, f.optString("title"), "运行出错：" + clip(f.optString("msg"), 200), s, nid).setCategory(Notification.CATEGORY_ERROR).build());
    }

    private void simple(int nid, String channel, String title, String text, String session) {
        nm.notify(nid, base(channel, title, text, session, nid).build());
    }

    private PendingIntent open(String session, int rc) {
        Intent i = new Intent(this, MainActivity.class)
                .setAction("open:" + (session == null ? "" : session))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (session != null && !session.isEmpty()) i.putExtra("session", session);
        return PendingIntent.getActivity(this, rc, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The service intent behind an Allow / Deny button; wrapped into a PendingIntent by action(). */
    private Intent act(String action, JSONObject f, int nid) {
        return new Intent(this, NotifyService.class)
                .setAction(action)
                .putExtra("rpc", f.optString("rpc"))
                .putExtra("s", f.optString("s"))
                .putExtra("id", f.optString("id"))
                .putExtra("nid", nid);
    }

    /** Answer an approval straight from the notification. */
    private void answer(Intent in) {
        int nid = in.getIntExtra("nid", 0);
        String outcome = ACTION_ALLOW.equals(in.getAction()) ? "allowed-once" : "rejected";
        try {
            JSONObject value = new JSONObject()
                    .put("sessionId", in.getStringExtra("s"))
                    .put("approvalId", in.getStringExtra("id"))
                    .put("outcome", outcome);
            JSONObject body = new JSONObject()
                    .put("rpcId", in.getStringExtra("rpc"))
                    .put("result", new JSONObject().put("ok", true).put("value", value));
            post("/m/api/respond", body);
            nm.cancel(nid);
        } catch (Exception e) {
            simple(nid, CH_ALERT, "没有提交成功", "点开 App 处理这个确认", in.getStringExtra("s"));
        }
    }

    /** Answer a question from the notification: one option, or typed text. */
    private void answerQuestion(Intent in) {
        int nid = in.getIntExtra("nid", 0);
        String s = in.getStringExtra("s");
        try {
            JSONObject ans = new JSONObject().put("id", in.getStringExtra("qid"));
            String label = in.getStringExtra("label");
            if (ACTION_ANSWER.equals(in.getAction()) && label != null) {
                ans.put("selected", new JSONArray().put(label));
            } else {
                String text = typed(in);
                if (text.isEmpty()) {
                    nm.cancel(nid);
                    return;
                }
                ans.put("selected", new JSONArray()).put("custom", text);
            }
            JSONObject value = new JSONObject().put("sessionId", s).put("answer", new JSONObject().put("answers", new JSONArray().put(ans)));
            post("/m/api/respond", new JSONObject().put("rpcId", in.getStringExtra("rpc")).put("result", new JSONObject().put("ok", true).put("value", value)));
            nm.cancel(nid);
        } catch (Exception e) {
            simple(nid, CH_ALERT, "没有提交成功", "点开 App 回答这个问题", s);
        }
    }

    /** The next instruction typed under a "done" notice: DSH sessions and Claude Code / Codex alike. */
    private void reply(Intent in) {
        int nid = in.getIntExtra("nid", 0);
        String s = in.getStringExtra("s");
        String text = typed(in);
        if (text.isEmpty() || s == null) {
            nm.cancel(nid);
            return;
        }
        try {
            if (s.startsWith("agent:")) {
                post("/m/api/agents/prompt", new JSONObject().put("s", s).put("text", text));
            } else {
                JSONObject payload = new JSONObject().put("sessionId", s).put("mode", "queue")
                        .put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", text)));
                post("/m/api/rpc", new JSONObject().put("method", "session.prompt").put("payload", payload));
            }
            // Re-post without the input: this is also what stops the notification's reply spinner.
            simple(nid, CH_DONE, in.getStringExtra("title"), "已发送：" + clip(text, 120), s);
        } catch (Exception e) {
            simple(nid, CH_ALERT, "没有发出去", "点开 App 再发一次：" + clip(text, 80), s);
        }
    }

    private JSONObject post(String path, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(MainActivity.server(this) + path).openConnection();
        try {
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            String cookie = prefs.getString("cookie", "");
            if (!cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = c.getOutputStream()) {
                os.write(out);
            }
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            JSONObject j = new JSONObject(readAll(c.getInputStream()));
            if (!j.optBoolean("ok")) throw new IOException(j.toString());
            return j;
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int k;
        while ((k = in.read(buf)) > 0) b.write(buf, 0, k);
        return b.toString("UTF-8");
    }

    private static int idFor(String key) {
        return (key.hashCode() & 0x3fffffff) | 0x100; // never collides with ID_BG / ID_LOGIN
    }

    private static String clip(String s, int n) {
        return s == null ? "" : s.length() > n ? s.substring(0, n) + "…" : s;
    }

    private static String dur(long ms) {
        long s = Math.round(ms / 1000.0);
        if (s < 60) return s + "秒";
        long m = s / 60;
        if (m < 60) return m + "分" + (s % 60 > 0 ? (s % 60) + "秒" : "");
        return (m / 60) + "小时" + (m % 60 > 0 ? (m % 60) + "分" : "");
    }

    private void nap(long ms) {
        if (!running) return;
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            // woken early by a network change
        }
    }

    static class LoginRequired extends Exception {
    }
}
