package com.agenthub.dsh;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Home-screen widget: how many things wait for you, how many DSH sessions are
 * running, and the last finished task. NotifyService keeps the numbers in the
 * "dsh" preferences (from the plugin's "st" frames and its done / err notices)
 * and calls refresh() when they change; the widget itself never polls.
 */
public class StatusWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        m.updateAppWidget(ids, views(ctx));
    }

    /** Redraw every placed widget; cheap no-op when none is on the home screen. */
    static void refresh(Context ctx) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        if (m == null) return;
        int[] ids = m.getAppWidgetIds(new ComponentName(ctx, StatusWidget.class));
        if (ids == null || ids.length == 0) return;
        m.updateAppWidget(ids, views(ctx));
    }

    private static RemoteViews views(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences("dsh", Context.MODE_PRIVATE);
        int asks = p.getInt("w_asks", 0);
        int run = p.getInt("w_run", 0);
        String link = p.getString("w_link", "");
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);

        String main;
        if (asks > 0) main = asks + " 个等你确认" + (run > 0 ? " · " + run + " 个在跑" : "");
        else if (run > 0) main = run + " 个在跑";
        else main = "没有要你处理的";
        v.setTextViewText(R.id.w_main, main);
        v.setTextColor(R.id.w_main, ctx.getColor(asks > 0 ? R.color.w_warn : R.color.w_text));

        String state;
        int stateColor = R.color.w_sub;
        switch (link) {
            case "ok": state = "● 已连接"; stateColor = R.color.w_ok; break;
            case "login": state = "需要登录"; stateColor = R.color.w_warn; break;
            case "off": state = "未连接"; break;
            default: state = ""; break;
        }
        v.setTextViewText(R.id.w_link, state);
        v.setTextColor(R.id.w_link, ctx.getColor(stateColor));

        String title = p.getString("w_last_title", "");
        long at = p.getLong("w_last_at", 0);
        String line;
        if (title.isEmpty() || at == 0) line = "还没有完成的任务";
        else line = when(at) + ("err".equals(p.getString("w_last_kind", "")) ? " 出错：" : " 完成：") + title;
        v.setTextViewText(R.id.w_last, line);

        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        return v;
    }

    /** "15:42" today, "9月22日" before. The widget is redrawn on every change, so this stays close enough. */
    private static String when(long at) {
        Calendar now = Calendar.getInstance();
        Calendar t = Calendar.getInstance();
        t.setTimeInMillis(at);
        boolean today = now.get(Calendar.YEAR) == t.get(Calendar.YEAR) && now.get(Calendar.DAY_OF_YEAR) == t.get(Calendar.DAY_OF_YEAR);
        return new SimpleDateFormat(today ? "HH:mm" : "M月d日", Locale.CHINA).format(new Date(at));
    }
}
