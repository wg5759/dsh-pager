"""Run the candidate's actual fullscreen/lifecycle method bodies with host View stubs.

This verifies state transitions, not WebView rendering or a physical device.
"""
from pathlib import Path
import argparse
import os
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-home', default=os.environ.get('JDK_HOME') or os.environ.get('JAVA_HOME'))
parser.add_argument('--output-dir', type=Path, help='Retain generated host harness and receipt in this directory')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = (root / 'src/com/agenthub/dsh/MainActivity.java').read_text(encoding='utf-8-sig')

def method(name):
    match = re.search(r'^    (?:public |protected )?void ' + name + r'\([^)]*\) \{', source, re.M)
    if not match:
        raise RuntimeError('Candidate method not found: ' + name)
    start = match.start()
    index = source.index('{', start)
    depth = 1
    while depth:
        index += 1
        depth += (source[index] == '{') - (source[index] == '}')
    return source[start:index + 1]

methods = '\n'.join(method(name) for name in ('showFullscreen', 'hideFullscreen', 'exitFullscreen', 'onNewIntent', 'onBackPressed', 'onDestroy'))
java = r'''
import java.util.ArrayList;
class View {
    static final int SYSTEM_UI_FLAG_FULLSCREEN=4, SYSTEM_UI_FLAG_HIDE_NAVIGATION=2, SYSTEM_UI_FLAG_IMMERSIVE_STICKY=4096;
    ViewGroup parent; int ui, background;
    Object getParent() { return parent; }
    int getSystemUiVisibility() { return ui; }
    void setSystemUiVisibility(int value) { ui=value; }
    void setBackgroundColor(int value) { background=value; }
}
class ViewGroup extends View {
    static class LayoutParams { static final int MATCH_PARENT=-1; }
    final ArrayList<View> children=new ArrayList<>();
    void addView(View view) { if (view.parent!=null) throw new AssertionError("view already attached"); children.add(view); view.parent=this; }
    void removeView(View view) { children.remove(view); view.parent=null; }
}
class FrameLayout extends ViewGroup { static class LayoutParams { LayoutParams(int w,int h) {} } }
class WindowManager { static class LayoutParams { static final int FLAG_FULLSCREEN=1024; int flags; } }
class Window {
    final View decor=new View(); final ViewGroup content=new ViewGroup(); final WindowManager.LayoutParams attrs=new WindowManager.LayoutParams();
    View getDecorView() { return decor; }
    WindowManager.LayoutParams getAttributes() { return attrs; }
    void addContentView(View v,FrameLayout.LayoutParams p) { content.addView(v); }
    void addFlags(int flags) { attrs.flags|=flags; }
    void clearFlags(int flags) { attrs.flags&=~flags; }
}
class Color { static final int BLACK=0xff000000; }
class WebChromeClient { interface CustomViewCallback { void onCustomViewHidden(); } }
class WebView extends View {
    boolean hasHistory; int backs, evaluations; String script;
    boolean canGoBack() { return hasHistory; }
    void goBack() { backs++; }
    void evaluateJavascript(String value,Object cb) { evaluations++; script=value; }
}
class Intent { final String session; Intent(String value) { session=value; } String getStringExtra(String key) { return session; } }
class JSONObject { static String quote(String value) { return "\""+value+"\""; } }
class Activity {
    final Window window=new Window(); int orientation=7, moves, destroys;
    Window getWindow() { return window; }
    int getRequestedOrientation() { return orientation; }
    void setRequestedOrientation(int value) { orientation=value; }
    boolean moveTaskToBack(boolean nonRoot) { moves++; return true; }
    public void onBackPressed() {}
    protected void onNewIntent(Intent value) {}
    void setIntent(Intent value) {}
    protected void onDestroy() { destroys++; }
}
class MainActivity extends Activity {
    final WebView web=new WebView();
    View fullscreenView;
    WebChromeClient.CustomViewCallback fullscreenCallback;
    int fullscreenSystemUi, fullscreenOrientation;
    boolean wasFullscreen;
    int shares;
    MainActivity() { window.content.addView(web); window.decor.ui=8192; window.attrs.flags=32; }
    void handleShare(Intent value) { shares++; }
__METHODS__
}
class Callback implements WebChromeClient.CustomViewCallback {
    int calls; Runnable onCall;
    public void onCustomViewHidden() { calls++; if (onCall!=null) onCall.run(); }
}
public class FullscreenLifecycleCheck {
    static int checks;
    static void check(boolean passed,String name) { if (!passed) throw new AssertionError(name); checks++; System.out.println("PASS "+name); }
    public static void main(String[] args) {
        MainActivity a=new MainActivity(); View video=new View(); Callback cb=new Callback();
        a.showFullscreen(video,cb);
        check(a.fullscreenView==video && a.fullscreenCallback==cb && video.parent==a.window.content && a.web.parent==a.window.content && a.window.content.children.size()==2,"same custom view and original WebView stay attached");
        check(a.orientation==7 && a.window.decor.ui==(8192|4|2|4096) && a.window.attrs.flags==(32|1024),"enter saves orientation and adds fullscreen UI without removing prior flags");
        View duplicate=new View(); Callback rejected=new Callback(); a.showFullscreen(duplicate,rejected);
        check(rejected.calls==1 && cb.calls==0 && a.fullscreenView==video && duplicate.parent==null,"duplicate show rejects only the new callback");
        a.orientation=0; a.hideFullscreen(); a.hideFullscreen();
        check(a.fullscreenView==null && a.fullscreenCallback==null && video.parent==null && a.web.parent==a.window.content && a.window.content.children.size()==1 && a.orientation==7 && a.window.decor.ui==8192 && a.window.attrs.flags==32 && cb.calls==0,"native hide is idempotent and restores prior UI and orientation");
        a.web.hasHistory=true; a.showFullscreen(video,cb); cb.onCall=a::hideFullscreen; a.onBackPressed();
        check(cb.calls==1 && a.web.backs==0 && a.moves==0 && video.parent==null,"first system back exits fullscreen only and tolerates reentrant onHide");
        a.onBackPressed(); a.web.hasHistory=false; a.onBackPressed();
        check(a.web.backs==1 && a.moves==1,"subsequent back keeps original web history and leave behavior");
        MainActivity existing=new MainActivity(); existing.window.attrs.flags|=1024; existing.showFullscreen(new View(),new Callback()); existing.hideFullscreen();
        check(existing.window.attrs.flags==(32|1024),"preexisting fullscreen flag remains after exit");
        MainActivity dying=new MainActivity(); View dyingView=new View(); Callback dyingCb=new Callback(); dying.showFullscreen(dyingView,dyingCb); dying.onDestroy();
        check(dying.fullscreenView==null && dying.fullscreenCallback==null && dyingView.parent==null && dyingCb.calls==1 && dying.destroys==1,"activity destroy removes overlay and releases callback once");
        dying.exitFullscreen();
        check(dyingCb.calls==1,"repeated exit cannot re-notify a released callback");
        MainActivity navigation=new MainActivity(); View navigationView=new View(); Callback navigationCb=new Callback(); navigation.showFullscreen(navigationView,navigationCb);
        navigation.onNewIntent(new Intent(null));
        check(navigation.fullscreenView==navigationView && navigationCb.calls==0 && navigation.web.evaluations==0,"intent without a session keeps fullscreen playing");
        navigation.onNewIntent(new Intent(""));
        check(navigation.fullscreenView==navigationView && navigationCb.calls==0 && navigation.web.evaluations==1,"empty session keeps fullscreen and preserves original JS dispatch");
        navigation.onNewIntent(new Intent("session-123"));
        check(navigation.fullscreenView==null && navigationView.parent==null && navigationCb.calls==1 && navigation.web.evaluations==2 && navigation.web.script.contains("session-123") && navigation.shares==3,"session navigation exits fullscreen before keeping existing JS and share dispatch");
        System.out.println("PASS "+checks+" lifecycle checks; host stubs, physical WebView pending");
    }
}
'''.replace('__METHODS__', methods)
work = args.output_dir.resolve() if args.output_dir else Path(tempfile.mkdtemp(prefix='dsh-fullscreen-check-'))
work.mkdir(exist_ok=True)
java_path = work / 'FullscreenLifecycleCheck.java'
java_path.write_text(java, encoding='utf-8')
suffix = '.exe' if os.name == 'nt' else ''
javac = str(Path(args.java_home) / 'bin' / ('javac' + suffix)) if args.java_home else shutil.which('javac')
java_runtime = str(Path(args.java_home) / 'bin' / ('java' + suffix)) if args.java_home else shutil.which('java')
if not javac or not java_runtime:
    raise RuntimeError('Use --java-home or set JDK_HOME/JAVA_HOME to a JDK, or put javac and java on PATH')
compile_result = subprocess.run([javac, '-encoding', 'UTF-8', '--release', '11', '-d', str(work), str(java_path)], capture_output=True, text=True)
run_result = subprocess.run([java_runtime, '-cp', str(work), 'FullscreenLifecycleCheck'], capture_output=True, text=True) if compile_result.returncode == 0 else None
receipt = compile_result.stdout + compile_result.stderr + (run_result.stdout + run_result.stderr if run_result else '')
(work / 'lifecycle-receipt.txt').write_text(receipt, encoding='utf-8')
print(receipt)
raise SystemExit(compile_result.returncode or (run_result.returncode if run_result else 1))
