package com.agenthub.dsh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts background alerts after a reboot or an app update, once a server has been set up. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        boolean ours = Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a);
        if (ours && !MainActivity.server(c).isEmpty()) NotifyService.start(c);
    }
}
