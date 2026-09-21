package com.agenthub.dsh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;
import android.widget.Toast;

/**
 * Result of an in-app update (see MainActivity.update): Android first asks the
 * user to confirm the install (STATUS_PENDING_USER_ACTION), then reports
 * success or failure. The confirmation can never be skipped, by design.
 */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context c, Intent i) {
        int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(confirm);
            }
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            Log.w("DSHUpdate", "install ended with status " + status + ": " + msg);
            if (status != PackageInstaller.STATUS_FAILURE_ABORTED) {
                Toast.makeText(c, "更新没有完成：" + (msg == null ? "状态 " + status : msg), Toast.LENGTH_LONG).show();
            }
        }
    }
}
