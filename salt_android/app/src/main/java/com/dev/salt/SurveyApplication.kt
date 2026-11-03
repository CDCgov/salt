package com.dev.salt
import android.app.Application
import android.content.Context
import com.dev.salt.logging.AppLogger as Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import com.dev.salt.data.SurveyDatabase
import java.io.IOException
import kotlin.concurrent.read
import kotlin.io.path.exists
import java.io.File
import java.io.FileOutputStream
import net.sqlcipher.database.SQLiteDatabase
import com.dev.salt.logging.AppLogger

class SurveyApplication : Application() {
    private val applicationScope = CoroutineScope(Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()

        // Initialize AppLogger FIRST (before any log calls)
        AppLogger.init(this)
        AppLogger.i("SurveyApplication", "SALT Application starting...")

        Log.e("SurveyApplication", "onCreate called")

        // Initialize SQLCipher
        SQLiteDatabase.loadLibs(this)
        Log.d("SurveyApplication", "SQLCipher initialized")
        
        setupGlobalExceptionHandler()
    }

    fun copyRawFilesToLocalStorage(context: Context) {
        val rawFiles = listOf("question1", "yes", "no", "dont_know", "dont_want_to_answer", "question2",
            "less_than_a_year_ago", "over_a_year_ago", "question3", "dont_remember", "question4", "none", "one", "more_than_one", "dont_know_or_dont_want_to_answer", "question5") // Replace with your actual raw file names

        val audioDir = File(context.filesDir, "audio")
        if (!audioDir.exists()) {
            audioDir.mkdirs()
        }

        for (fileName in rawFiles) {
            try {
                val resourceId = context.resources.getIdentifier(fileName, "raw", context.packageName)
                val inputStream = context.resources.openRawResource(resourceId)
                val outputStream = FileOutputStream(File(audioDir, "$fileName.mp3")) // Assuming your raw files are MP3s

                val buffer = ByteArray(1024)
                var length: Int
                while (inputStream.read(buffer).also { length = it } > 0) {
                    outputStream.write(buffer, 0, length)
                }

                inputStream.close()
                outputStream.close()
            } catch (e: IOException) {
                e.printStackTrace()
            }
        }
    }

    private fun setupGlobalExceptionHandler() {
        val defaultExceptionHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            // Log the exception
            Log.e("MyApplication", "Unhandled exception in thread: ${thread.name}", throwable)

            // You can add more custom logic here, like:
            // - Sending the crash report to a server
            // - Displaying a user-friendly error message (though be careful with UI from here)
            // - Performing cleanup tasks

            // It's generally a good idea to also call the original default handler
            // if you want the system to handle the crash as it normally would (e.g., show "App has stopped").
            // If you don't call it, the app might just freeze or behave unexpectedly.
            defaultExceptionHandler?.uncaughtException(thread, throwable)

            // Alternatively, if you want to force the app to close immediately after logging:
            // exitProcess(1) // Be cautious with this, as it bypasses normal shutdown procedures.
        }
    }

    override fun onTerminate() {
        AppLogger.i("SurveyApplication", "SALT Application terminating...")
        AppLogger.shutdown()
        super.onTerminate()
    }

}