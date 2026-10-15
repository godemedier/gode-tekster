package dk.godemedier.godetekster

import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android 15+ tegner appen under statuslinjen og tastaturet, og adjustResize virker ikke
    // længere. Uden polstring skjuler tastaturet de nederste linjer, man skriver i (14/10).
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // wry lægger WebView'et ind med setContentView. Rammen omkring kan rette markeringsmenuen,
  // før den vises.
  override fun setContentView(view: View?) {
    if (view == null) return super.setContentView(view)
    val frame = MenuFilterFrame(this)
    frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    super.setContentView(frame)
  }
}

// Markeringsmenuen skal kun have Androids egne punkter. Select to Speak lægger »Oplæsning« ind
// som tekstbehandler (15/10). Punktet skjules hver gang menuen bygges, også når markeringen ændres.
private class MenuFilterFrame(context: Context) : FrameLayout(context) {
  override fun startActionModeForChild(originalView: View, callback: ActionMode.Callback, type: Int): ActionMode? =
    super.startActionModeForChild(originalView, Filtered(callback), type)

  private class Filtered(private val inner: ActionMode.Callback) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean =
      inner.onCreateActionMode(mode, menu).also { hide(menu) }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean =
      inner.onPrepareActionMode(mode, menu).also { hide(menu) }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean = inner.onActionItemClicked(mode, item)

    override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
      if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect) else super.onGetContentRect(mode, view, outRect)
    }

    private fun hide(menu: Menu) {
      for (i in 0 until menu.size()) {
        val item = menu.getItem(i)
        val intent = item.intent ?: continue
        if (intent.action == Intent.ACTION_PROCESS_TEXT && intent.component?.packageName == READ_ALOUD) item.isVisible = false
      }
    }
  }
}

private const val READ_ALOUD = "com.google.android.marvin.talkback"
