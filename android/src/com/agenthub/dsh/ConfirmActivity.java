package com.agenthub.dsh;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

/**
 * A no-UI shim for notification actions that must not run until the phone is
 * unlocked: Allow a tool call, answer a question, send a reply. It dismisses the
 * keyguard (KeyguardManager.requestDismissKeyguard) and only then hands the real
 * action, its extras, and any typed text on to NotifyService.
 *
 * This replaces Notification.Action.Builder.setAuthenticationRequired, whose
 * "unlock, then fire the action" flow is not delivered on some OEM builds: on
 * HarmonyOS a tap on "允许" while locked did nothing (logcat showed only
 * canShowActivityWhileKeyguardShowing=false and no action ever reached the
 * service). Denying needs no unlock and never comes through here.
 */
public class ConfirmActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // Appear above the lock screen so the keyguard prompt can come up right away.
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true);
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isKeyguardLocked()) {
            forward();
            return;
        }
        km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
            @Override public void onDismissSucceeded() { forward(); }
            @Override public void onDismissCancelled() { finish(); }
            @Override public void onDismissError() { finish(); }
        });
    }

    private void forward() {
        Intent src = getIntent();
        Intent svc = new Intent(this, NotifyService.class).setAction(src.getStringExtra("fwd"));
        Bundle extras = src.getExtras();
        if (extras != null) svc.putExtras(extras);
        // Carry the typed reply (RemoteInput) across to the service unchanged.
        Bundle typed = RemoteInput.getResultsFromIntent(src);
        if (typed != null) {
            RemoteInput ri = new RemoteInput.Builder(NotifyService.KEY_TEXT).build();
            RemoteInput.addResultsToIntent(new RemoteInput[]{ ri }, svc, typed);
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
            else startService(svc);
        } catch (Exception ignored) {
        }
        finish();
    }
}
