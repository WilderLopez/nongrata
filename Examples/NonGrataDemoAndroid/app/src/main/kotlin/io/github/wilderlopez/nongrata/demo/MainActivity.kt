package io.github.wilderlopez.nongrata.demo

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import io.github.wilderlopez.nongrata.CheckIntent
import io.github.wilderlopez.nongrata.NonGrata
import io.github.wilderlopez.nongrata.NonGrataVerdict

/**
 * Shows the verdict and the support code, and has a button for each kind of check. A real app
 * would draw its own blocking screen when the verdict is `Blocked`; the SDK never closes the app.
 */
class MainActivity : Activity() {
    private lateinit var nonGrata: NonGrata
    private lateinit var verdictView: TextView
    private lateinit var lastCheckView: TextView
    private val listener = NonGrata.VerdictListener { show(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        nonGrata = (application as DemoApplication).nonGrata

        // targetSdk 35+ draws edge to edge: keep the content clear of the system bars.
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { view, insets ->
            @Suppress("DEPRECATION")
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }

        verdictView = findViewById(R.id.verdict)
        lastCheckView = findViewById(R.id.last_check)
        findViewById<TextView>(R.id.worker).text = getString(
            R.string.worker_value,
            BuildConfig.NONGRATA_WORKER_URL,
            BuildConfig.NONGRATA_APP_ID,
            BuildConfig.NONGRATA_HASH_PREFIX,
        )

        val userId = findViewById<EditText>(R.id.user_id)
        val buttons = mapOf(
            R.id.check_launch to CheckIntent.LAUNCH,
            R.id.check_foreground to CheckIntent.FOREGROUND,
            R.id.check_login to CheckIntent.LOGIN,
            R.id.check_signup to CheckIntent.SIGNUP,
            R.id.check_refresh to CheckIntent.REFRESH,
        )
        for ((id, intent) in buttons) {
            findViewById<Button>(id).setOnClickListener {
                check(intent, userId.text.toString().trim().ifEmpty { null })
            }
        }

        show(nonGrata.verdict)
        nonGrata.addListener(listener)
    }

    override fun onRestart() {
        super.onRestart()
        // Back from the background: throttled by the SDK while allowed.
        check(CheckIntent.FOREGROUND, null)
    }

    override fun onDestroy() {
        nonGrata.removeListener(listener)
        super.onDestroy()
    }

    private fun check(intent: CheckIntent, userId: String?) {
        lastCheckView.text = getString(R.string.checking)
        nonGrata.check(intent, userId) { verdict ->
            Log.i(TAG, "check ${intent.wireValue}: $verdict")
            lastCheckView.text = if (intent == CheckIntent.SIGNUP) {
                val permitted = nonGrata.permits(verdict, intent)
                getString(
                    R.string.last_check_signup,
                    intent.wireValue,
                    describe(verdict),
                    getString(if (permitted) R.string.signup_permitted else R.string.signup_refused),
                )
            } else {
                getString(R.string.last_check, intent.wireValue, describe(verdict))
            }
            show(verdict)
        }
    }

    private fun show(verdict: NonGrataVerdict) {
        verdictView.text = describe(verdict)
        findViewById<TextView>(R.id.support_code).text = nonGrata.supportCode ?: getString(R.string.none)
        findViewById<TextView>(R.id.install_id).text = nonGrata.installId ?: getString(R.string.none)
    }

    private fun describe(verdict: NonGrataVerdict): String = when (verdict) {
        NonGrataVerdict.Allowed -> getString(R.string.verdict_allowed)
        is NonGrataVerdict.Blocked -> getString(R.string.verdict_blocked, verdict.ref)
        NonGrataVerdict.Unknown -> getString(R.string.verdict_unknown)
    }

    private companion object {
        const val TAG = "NonGrataDemo"
    }
}
