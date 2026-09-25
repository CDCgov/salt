package com.dev.salt.i18n

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import java.util.Locale

/**
 * Manages the application language globally across all users.
 * Language preference is stored in SharedPreferences and applied at app startup.
 */
object LanguageManager {
    private const val PREFS_NAME = "salt_language_prefs"
    private const val KEY_LANGUAGE_CODE = "app_language_code"
    private const val DEFAULT_LANGUAGE = "system" // Use system language by default

    data class LanguageOption(
        val code: String,
        val displayName: String,
        val nativeName: String
    )

    /**
     * Get the list of available languages by detecting which resource directories exist.
     * This dynamically discovers languages based on values-XX folders with strings.xml
     */
    fun getAvailableLanguages(context: Context): List<LanguageOption> {
        val languages = mutableListOf(
            LanguageOption("system", "System Default", "")
        )

        // English is always available (default values folder)
        languages.add(LanguageOption("en", "English", "English"))

        // Detect available locales from the app's resources
        val configuration = Configuration(context.resources.configuration)

        // Check for known language codes by attempting to load a string resource
        // with that locale and seeing if it differs from default
        val knownLanguages = listOf(
            Triple("es", "Spanish", "Espa\u00F1ol"),
            Triple("hy", "Armenian", "\u0540\u0561\u0575\u0565\u0580\u0565\u0576"),
            Triple("fr", "French", "Fran\u00E7ais"),
            // Indonesian: Java/Android map "id" to the legacy code "in", so the
            // resources live in values-in/.
            Triple("id", "Indonesian", "Bahasa Indonesia"),
            Triple("ru", "Russian", "\u0420\u0443\u0441\u0441\u043A\u0438\u0439"),
            Triple("pt", "Portuguese", "Portugu\u00EAs"),
            Triple("zh", "Chinese", "\u4E2D\u6587"),
            Triple("ar", "Arabic", "\u0627\u0644\u0639\u0631\u0628\u064A\u0629"),
            Triple("hi", "Hindi", "\u0939\u093F\u0928\u094D\u0926\u0940"),
            Triple("sw", "Swahili", "Kiswahili"),
            Triple("am", "Amharic", "\u12A0\u121B\u122D\u129B")
        )

        for ((code, englishName, nativeName) in knownLanguages) {
            if (isLanguageAvailable(context, code)) {
                languages.add(LanguageOption(code, englishName, nativeName))
            }
        }

        return languages
    }

    /**
     * Probe strings used to detect whether a language is available. The language
     * is considered installed if ANY of these differ from the English version,
     * since a single probe is fragile — e.g. French's natural translation of
     * common_ok is also "OK", which would otherwise make French look absent.
     */
    private val LANGUAGE_PROBE_KEYS = listOf(
        "common_ok", "common_cancel", "common_continue",
        "login_title", "common_logout"
    )

    /**
     * Check if a language is available by testing if any of several probe
     * strings differs from English when loaded under that locale.
     */
    private fun isLanguageAvailable(context: Context, languageCode: String): Boolean {
        try {
            val locale = Locale(languageCode)
            val config = Configuration(context.resources.configuration)
            config.setLocale(locale)
            val localizedResources = context.createConfigurationContext(config).resources

            val englishConfig = Configuration(context.resources.configuration)
            englishConfig.setLocale(Locale.ENGLISH)
            val englishResources = context.createConfigurationContext(englishConfig).resources

            for (key in LANGUAGE_PROBE_KEYS) {
                val id = context.resources.getIdentifier(key, "string", context.packageName)
                if (id == 0) continue
                if (localizedResources.getString(id) != englishResources.getString(id)) {
                    return true
                }
            }
            return false
        } catch (e: Exception) {
            return false
        }
    }

    /**
     * Get the current language code from preferences
     */
    fun getCurrentLanguageCode(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_LANGUAGE_CODE, DEFAULT_LANGUAGE) ?: DEFAULT_LANGUAGE
    }

    /**
     * Set the application language globally
     */
    fun setLanguage(context: Context, languageCode: String) {
        // Save to preferences
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_LANGUAGE_CODE, languageCode).apply()

        // Apply the language immediately
        applyLanguage(context, languageCode)
    }

    /**
     * Apply the saved language preference to the application
     * This should be called in Application.onCreate() or Activity.attachBaseContext()
     */
    fun applyLanguage(context: Context, languageCode: String = getCurrentLanguageCode(context)): Context {
        if (languageCode == "system") {
            // Use system default, no override needed
            return context
        }

        val locale = Locale(languageCode)
        return updateResources(context, locale)
    }

    /**
     * Update the app's resources with the specified locale
     */
    private fun updateResources(context: Context, locale: Locale): Context {
        Locale.setDefault(locale)

        val configuration = Configuration(context.resources.configuration)
        configuration.setLocale(locale)

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            context.createConfigurationContext(configuration)
        } else {
            @Suppress("DEPRECATION")
            context.resources.updateConfiguration(configuration, context.resources.displayMetrics)
            context
        }
    }

    /**
     * Wrap the activity context to apply the saved language
     * Call this in every Activity's attachBaseContext()
     */
    fun wrapContext(context: Context): Context {
        val languageCode = getCurrentLanguageCode(context)
        return applyLanguage(context, languageCode)
    }

    /**
     * Get the display name for the current language
     */
    fun getCurrentLanguageDisplayName(context: Context): String {
        val currentCode = getCurrentLanguageCode(context)
        val languages = getAvailableLanguages(context)
        return languages.find { it.code == currentCode }?.displayName ?: "System Default"
    }

    /**
     * Check if the app needs to restart after language change
     * (Required for complete UI update)
     */
    fun requiresRestart(): Boolean = true
}
