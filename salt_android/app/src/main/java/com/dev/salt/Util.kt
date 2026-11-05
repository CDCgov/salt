package com.dev.salt

import android.content.Context
import android.media.MediaPlayer
import com.dev.salt.logging.AppLogger as Log
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.MessageDigest
import kotlin.random.Random

import org.apache.commons.jexl3.JexlBuilder
import org.apache.commons.jexl3.MapContext
import org.apache.commons.jexl3.JexlException
import java.io.File
import java.io.IOException
import kotlin.io.encoding.Base64

import java.security.NoSuchAlgorithmException
import java.security.spec.InvalidKeySpecException
import java.security.spec.KeySpec
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec


/*fun randomHash(): String {
    // Legacy function - kept for compatibility
    // New surveys should use generateWalkInSubjectId()
    return generateWalkInSubjectId()
}*/

/**
 * Generates a 6-character alphanumeric subject ID
 * Format: [A-Z0-9]{6}
 * Example: "AB3K7P"
 * @deprecated Use generateWalkInSubjectId() for walk-in participants
 */
fun generateSubjectId(): String {
    val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return (1..6)
        .map { chars.random() }
        .joinToString("")
}

/**
 * Generates a subject ID for walk-in participants (without coupon)
 * Format: W[cleaner-charset]{5}
 * Example: "WAC3K7"
 * The "W" prefix ensures no collision with coupon codes
 * Uses cleaner character set excluding ambiguous characters (0,O,1,I,L,Z,2,5,S,8,B)
 *
 * @deprecated Use CouponGenerator.generateUniqueWalkInSubjectId() instead to ensure uniqueness
 */
/*@Deprecated(
    message = "Use CouponGenerator.generateUniqueWalkInSubjectId() instead to ensure uniqueness",
    replaceWith = ReplaceWith(
        "CouponGenerator(couponDao, surveyDao).generateUniqueWalkInSubjectId()",
        "com.dev.salt.util.CouponGenerator"
    ),
    level = DeprecationLevel.WARNING
)
fun generateWalkInSubjectId(): String {
    // Cleaner character set excluding ambiguous characters
    val chars = "ACDEFGHJKMNPQRTUVWXY34679"
    val randomPart = (1..5)
        .map { chars.random() }
        .joinToString("")
    return "W$randomPart"
}*/




// Lazy-initialized JEXL engine instance for efficiency.
// This ensures the JexlEngine is created only once when first needed.
private val jexlEngine by lazy {
    JexlBuilder()
        .cache(512)      // Enable expression cache for better performance on repeated scripts.
        .strict(true)    // Enforce strict behavior (e.g., undefined variables cause errors). Recommended.
        .silent(false)   // If true, errors are suppressed and return null. If false, JexlExceptions are thrown.
        // Setting to false allows for more explicit error handling in the catch blocks.
        .create()
}


/**
 * Built-in JEXL variables available to every survey script and lab test
 * condition. Their names start with "_", which the server reserves (no
 * question short name may start with "_"); the server's JEXL checker
 * (salt_management/src/services/builtinVariables.js) lists the same names.
 *
 * - `_facility_name`: this tablet's facility name (null before setup)
 * - `_facility_id`: this tablet's facility id on the server (null before setup)
 * - `_is_seed`: true when the participant came without a referral coupon
 */
fun builtinJexlVariables(facility: com.dev.salt.data.FacilityConfig?, referralCouponCode: String?): Map<String, Any?> =
    mapOf(
        "_facility_name" to facility?.facilityName,
        "_facility_id" to facility?.facilityId,
        "_is_seed" to referralCouponCode.isNullOrBlank()
    )

/**
 * Evaluates a JEXL (Java Expression Language) script string against a given data context.
 *
 * This function can be used to execute simple logical statements or expressions defined
 * in a string format, using data provided in the `contextData` map.
 *
 * @param script The JEXL script string to evaluate.
 *               If the script is null or blank, this function will return null.
 * @param contextData A map where keys are variable names that can be used within the
 *                    JEXL script, and values are the corresponding data for those variables.
 * @param throwErrors If true, exceptions will be thrown instead of returning null.
 *                    Useful for debugging to see the actual error messages.
 * @return The result of the script evaluation as `Any?` (meaning it can be any type, or null).
 *         Returns null if:
 *         - The input `script` is null or blank.
 *         - An error occurs during script parsing or evaluation (an error will be logged).
 * @throws JexlException if throwErrors is true and an evaluation error occurs
 */
fun evaluateJexlScript(script: String?, contextData: Map<String, Any?>, throwErrors: Boolean = false): Any? {
    // If the script string is null or effectively empty, no evaluation is performed.
    if (script.isNullOrBlank()) {
        Log.d("JexlEvaluate", "Script is null or blank. No evaluation needed, returning null.")
        return null // Or you might define a default return value based on your application's logic.
    }

    return try {
        // Create a JEXL expression object from the script string.
        // The jexlEngine (being cached) might return a pre-compiled expression if seen before.
        val expression = jexlEngine.createExpression(script)

        // Create a JEXL context, wrapping the provided contextData map.
        // This makes the keys in contextData available as variables in the script.
        val context = MapContext(contextData)

        // Evaluate the expression against the context.
        val result = expression.evaluate(context)

        Log.d("JexlEvaluate", "Successfully evaluated script '$script'. Result: $result")
        result // Return the outcome of the evaluation.
    } catch (e: JexlException.Variable) {
        // Handles errors where the script refers to a variable not defined in the contextData.
        Log.e("JexlEvaluate", "JEXL Error: Undefined variable '${e.variable}' in script '$script'. Available context keys: ${contextData.keys}", e)
        if (throwErrors) throw e else null
    } catch (e: JexlException.Method) {
        // Handles errors where the script tries to call a method that doesn't exist or isn't accessible.
        Log.e("JexlEvaluate", "JEXL Error: Undefined method '${e.method}' in script '$script'. Available context keys: ${contextData.keys}", e)
        if (throwErrors) throw e else null
    } catch (e: JexlException.Parsing) {
        // Handles syntax errors within the JEXL script itself.
        Log.e("JexlEvaluate", "JEXL Parsing Error: '${e.message}' for script '$script'", e)
        if (throwErrors) throw e else null
    } catch (e: JexlException) {
        // A general catch block for any other JEXL-specific exceptions.
        Log.e("JexlEvaluate", "A JEXL evaluation error occurred for script '$script'. Context keys: ${contextData.keys}", e)
        if (throwErrors) throw e else null
    } catch (e: Exception) {
        // A fallback catch block for any other unexpected exceptions during the process.
        Log.e("JexlEvaluate", "Unexpected error during JEXL script evaluation for script '$script'. Context keys: ${contextData.keys}", e)
        if (throwErrors) throw e else null
    }
}




// Helper function to play audio and return MediaPlayer
public fun playAudio(context: Context, audioFileName: String): MediaPlayer? {
    if (audioFileName.isEmpty()) {
        Log.d("PlayAudio", "Empty audio filename, skipping")
        return null
    }
    
    val audioFile = File(context.filesDir, "audio/$audioFileName")
    Log.d("PlayAudio", "Looking for audio file: ${audioFile.absolutePath}")
    
    return if (audioFile.exists()) {
        try {
            Log.d("PlayAudio", "Audio file exists, creating MediaPlayer")
            
            // Use MediaPlayer.create() which handles preparation automatically
            val mediaPlayer = MediaPlayer.create(context, android.net.Uri.fromFile(audioFile))
            
            if (mediaPlayer != null) {
                // Set audio attributes for better compatibility
                mediaPlayer.setAudioAttributes(
                    android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                        .setLegacyStreamType(android.media.AudioManager.STREAM_MUSIC)
                        .build()
                )
                
                // Log duration and file size to verify audio content
                val duration = mediaPlayer.duration
                val fileSize = audioFile.length()
                Log.d("PlayAudio", "MediaPlayer created successfully for: $audioFileName, duration: ${duration}ms, size: ${fileSize} bytes")
                
                // Start playing immediately
                mediaPlayer.start()
                Log.d("PlayAudio", "Started playing audio: $audioFileName")
                
                mediaPlayer
            } else {
                Log.e("PlayAudio", "MediaPlayer.create() returned null for: $audioFileName")
                null
            }
        } catch (e: Exception) {
            Log.e("PlayAudio", "Error creating MediaPlayer for: $audioFileName", e)
            e.printStackTrace()
            null
        }
    } else {
        Log.e("PlayAudio", "Audio file not found: ${audioFile.absolutePath}")
        null
    }
}
// Extension function to suspend until MediaPlayer completion
suspend fun MediaPlayer.awaitCompletion() {
    suspendCancellableCoroutine { continuation ->
        setOnCompletionListener {
            continuation.resume(Unit) {
                release() // Release MediaPlayer on cancellation
            }
        }
    }
}