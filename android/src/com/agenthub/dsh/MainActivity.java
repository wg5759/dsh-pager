package com.agenthub.dsh;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * dsh-pager phone app: a full-screen shell around the mobile UI that the DSH
 * plugin serves at /m on the user's own computer. The UI lives there, so it
 * updates without reinstalling this app; the shell adds what a web page cannot:
 * a launcher icon, no browser chrome, the system back gesture, the native photo
 * picker, background alerts (NotifyService) and an offline screen.
 *
 * The server address is entered on first launch (assets/setup.html) and can be
 * changed later from the app ("切换服务器"). A private build may preset it via
 * local.properties (see build.sh); nothing about a specific server is in source.
 */
public class MainActivity extends Activity {
    static final String SETUP = "file:///android_asset/setup.html";
    static final String OFFLINE = "file:///android_asset/offline.html";
    static final int PICK = 1;
    static final int REQ_NOTIFY = 2;

    WebView web;
    ValueCallback<Uri[]> fileCb;
    SharedPreferences prefs;
    /** Set while a non-app page (login / setup / offline) is showing; the next /m/ load drops it from history. */
    boolean dropHistory;
    boolean resumed;
    boolean askedThisLaunch;

    /** The configured server origin, e.g. https://dsh.example.com:8443 — or "" before setup. */
    static String server(Context c) {
        String s = c.getSharedPreferences("dsh", MODE_PRIVATE).getString("server", "");
        return s.isEmpty() ? c.getString(R.string.default_server).trim() : s;
    }

    String home() {
        return server(this) + "/m/";
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("dsh", MODE_PRIVATE);
        // Private builds let `adb forward ... webview_devtools_remote` inspect the page (authorised USB
        // debugging only). Public builds keep it off: DevTools can read the gateway cookie and drive DSH.
        WebView.setWebContentsDebuggingEnabled(BuildInfo.WEBVIEW_DEBUG);

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " DSHApp/" + BuildInfo.VERSION);

        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return route(v, r.getUrl());
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) {
                Uri u = Uri.parse(url);
                if (isOurs(u) && isRoot(u)) { // an auth gateway commonly lands on "/" after login
                    v.stopLoading();
                    v.loadUrl(home());
                    return;
                }
                if (!isApp(u)) dropHistory = true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                boolean app = isApp(Uri.parse(url));
                if (dropHistory && app) {
                    v.clearHistory(); // back from the app must not return to the login / setup / offline page
                    dropHistory = false;
                }
                CookieManager.getInstance().flush();
                if (app) { // reaching /m/ means the server (and any gateway login) accepts us
                    saveCookie();
                    NotifyService.start(MainActivity.this);
                    if (resumed) askPermissions();
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadUrl(OFFLINE + "?why=net&u=" + Uri.encode(home()));
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
                int code = resp.getStatusCode();
                if (r.isForMainFrame() && isApp(r.getUrl()) && code >= 500) v.loadUrl(OFFLINE + "?why=pc&u=" + Uri.encode(home()));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                boolean multi = p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                Intent i;
                if (Build.VERSION.SDK_INT >= 33) {
                    i = new Intent(MediaStore.ACTION_PICK_IMAGES);
                    if (multi) i.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, Math.min(6, MediaStore.getPickImagesMaxLimit()));
                } else {
                    i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multi);
                }
                try {
                    startActivityForResult(i, PICK);
                } catch (ActivityNotFoundException e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });

        if (saved != null) {
            web.restoreState(saved);
        } else if (server(this).isEmpty()) {
            web.loadUrl(SETUP);
        } else {
            String session = getIntent().getStringExtra("session");
            web.loadUrl(session == null ? home() : home() + "#" + Uri.encode(session)); // the app opens a #session deep link on boot
        }
    }

    // ------------------------------------------------------------------ routing

    static int port(Uri u) {
        int p = u.getPort();
        return p != -1 ? p : ("https".equals(u.getScheme()) ? 443 : 80);
    }

    boolean isOurs(Uri u) {
        Uri s = Uri.parse(server(this));
        return s.getHost() != null && s.getScheme() != null && s.getScheme().equals(u.getScheme())
                && s.getHost().equalsIgnoreCase(u.getHost()) && port(s) == port(u);
    }

    static boolean isRoot(Uri u) {
        String p = u.getPath();
        return p == null || p.isEmpty() || "/".equals(p);
    }

    boolean isApp(Uri u) {
        String p = u.getPath();
        return isOurs(u) && p != null && p.startsWith("/m/");
    }

    /** Our server stays inside; "/" becomes the app; dshapp:// is ours; everything else opens in the browser. */
    boolean route(WebView v, Uri u) {
        if ("dshapp".equals(u.getScheme())) {
            appLink(v, u);
            return true;
        }
        if ("file".equals(u.getScheme())) return false;
        if (!isOurs(u)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }
        if (isRoot(u)) {
            v.loadUrl(home());
            return true;
        }
        return false;
    }

    /**
     * dshapp://setup opens the server form; dshapp://setup?server=… saves it —
     * accepted only from the bundled setup page, so a remote page can never
     * silently repoint the app at another server.
     */
    void appLink(WebView v, Uri u) {
        if (!"setup".equals(u.getHost())) return;
        String entered = u.getQueryParameter("server");
        String current = v.getUrl();
        if (entered != null && current != null && current.startsWith(SETUP)) {
            String origin = normalize(entered);
            if (origin == null) {
                // Reload the form with the error rather than injecting script from
                // inside shouldOverrideUrlLoading: on a form-submit navigation that
                // injection was silently dropped (seen on a Huawei WebView).
                v.loadUrl(SETUP + "?error=1&value=" + Uri.encode(entered));
                return;
            }
            if (!origin.equals(prefs.getString("server", ""))) {
                prefs.edit().putString("server", origin).putString("cookie", "").remove("epoch").putLong("n", -1).apply();
                NotifyService.reconnect(this);
            }
            v.loadUrl(origin + "/m/");
            return;
        }
        String s = server(this);
        v.loadUrl(SETUP + (s.isEmpty() ? "" : "?current=" + Uri.encode(s)));
    }

    /** "host:port" or a full URL -> "scheme://host[:port]"; null if unusable. */
    static String normalize(String input) {
        String s = input.trim();
        if (s.isEmpty()) return null;
        if (s.matches("^[A-Za-z][A-Za-z0-9+.-]*://.*") && !s.matches("(?i)^https?://.*")) return null; // ftp://, ws://, ...
        if (!s.matches("(?i)^https?://.*")) {
            boolean local = s.matches("(?i)^(localhost|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|100\\.).*") || s.contains(".local");
            s = (local ? "http://" : "https://") + s;
        }
        Uri u = Uri.parse(s);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        String host = u.getHost();
        int port = u.getPort();
        if (!(scheme.equals("http") || scheme.equals("https")) || host == null) return null;
        if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
        // android.net.Uri is lenient ("ht!tp" parses as a host), so check the
        // authority strictly: DNS name, IPv4, or bracketed IPv6; valid port.
        boolean dns = host.matches("(?i)^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$");
        boolean v6 = host.matches("^\\[[0-9A-Fa-f:.]+\\]$");
        if (!(dns || v6) || port == 0 || port > 65535) return null;
        String rest = s.replaceFirst("(?i)^https?://", "");
        if (rest.matches("^[^/?#]*[@\\s].*")) return null; // user-info or spaces in the authority
        return scheme + "://" + host + (port != -1 ? ":" + port : "");
    }

    // ------------------------------------------------------------------ session & permissions

    /** Hands the server's cookies (an auth gateway's session, if any) to NotifyService. */
    void saveCookie() {
        String c = CookieManager.getInstance().getCookie(server(this) + "/");
        c = c == null ? "" : c;
        if (!c.equals(prefs.getString("cookie", ""))) prefs.edit().putString("cookie", c).apply();
    }

    /**
     * Notification permission first, then the battery-optimisation exemption.
     * Asked only while the app is actually on screen (a dialog raised behind
     * the lock screen is silently cancelled), at most once per launch; the
     * battery request at most twice ever.
     */
    void askPermissions() {
        if (askedThisLaunch || server(this).isEmpty()) return;
        askedThisLaunch = true;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            return;
        }
        askBattery();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req == REQ_NOTIFY && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) askBattery();
    }

    void askBattery() {
        PowerManager pm = getSystemService(PowerManager.class);
        int asked = prefs.getInt("batteryAsks", 0);
        if (pm.isIgnoringBatteryOptimizations(getPackageName()) || asked >= 2) return;
        prefs.edit().putInt("batteryAsks", asked + 1).apply();
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    // ------------------------------------------------------------------ lifecycle

    /** A notification was tapped while the app is alive: jump to its session. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String s = intent.getStringExtra("session");
        if (s != null) web.evaluateJavascript("window.dshOpen&&window.dshOpen(" + JSONObject.quote(s) + ")", null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        NotifyService.appVisible = true;
        askPermissions();
        // Finished-task notices are stale once the user is looking at the app.
        NotificationManager nm = getSystemService(NotificationManager.class);
        for (StatusBarNotification sb : nm.getActiveNotifications()) {
            if (NotifyService.CH_DONE.equals(sb.getNotification().getChannelId())) nm.cancel(sb.getId());
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != PICK || fileCb == null) {
            super.onActivityResult(req, res, data);
            return;
        }
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                out = new Uri[clip.getItemCount()];
                for (int k = 0; k < out.length; k++) out[k] = clip.getItemAt(k).getUri();
            } else if (data.getData() != null) {
                out = new Uri[] {data.getData()};
            }
        }
        fileCb.onReceiveValue(out);
        fileCb = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // like a native app: keep state, just leave
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        NotifyService.appVisible = false;
        CookieManager.getInstance().flush();
        if (!server(this).isEmpty()) saveCookie();
    }
}
