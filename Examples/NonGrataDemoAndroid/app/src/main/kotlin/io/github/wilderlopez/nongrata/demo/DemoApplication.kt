package io.github.wilderlopez.nongrata.demo

import android.app.Application
import io.github.wilderlopez.nongrata.CheckIntent
import io.github.wilderlopez.nongrata.NonGrata
import io.github.wilderlopez.nongrata.NonGrataConfiguration

/** Creates the one `NonGrata` of the app when it starts, as a real app would. */
class DemoApplication : Application() {
    lateinit var nonGrata: NonGrata
        private set

    override fun onCreate() {
        super.onCreate()
        nonGrata = NonGrata(
            this,
            NonGrataConfiguration(
                endpoint = BuildConfig.NONGRATA_WORKER_URL.trimEnd('/') + "/v1/device/check",
                appId = BuildConfig.NONGRATA_APP_ID,
                hashPrefix = BuildConfig.NONGRATA_HASH_PREFIX,
            ),
        )
        nonGrata.check(CheckIntent.LAUNCH)
    }
}
