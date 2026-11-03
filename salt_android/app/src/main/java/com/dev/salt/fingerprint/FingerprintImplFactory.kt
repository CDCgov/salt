package com.dev.salt.fingerprint

import android.content.Context
import com.dev.salt.BuildConfig
import com.dev.salt.util.EmulatorDetector
import com.dev.salt.logging.AppLogger as Log

/**
 * Chooses the fingerprint implementation. Fails closed in release builds:
 *
 * - The mock reader (which never matches a real person, so it silently disables
 *   duplicate-enrollment screening) is only used in DEBUG builds, on an
 *   emulator or when the SecuGen reader can't be created.
 * - In release builds, if the SecuGen reader can't be created, an
 *   [UnavailableFingerprintImpl] is returned. Its initializeDevice() returns
 *   false, so every screen shows its existing "scanner failed to initialize"
 *   error instead of continuing with a fake reader.
 */
object FingerprintImplFactory {
    private const val TAG = "FingerprintImplFactory"

    fun create(context: Context?): IFingerprintCapture {
        if (BuildConfig.DEBUG && (context == null || EmulatorDetector.isEmulator())) {
            Log.i(TAG, "Debug build on emulator or without context: using MOCK fingerprint reader")
            return MockFingerprintImpl()
        }
        if (context == null) {
            Log.e(TAG, "No context available: fingerprint reader unavailable")
            return UnavailableFingerprintImpl()
        }
        return try {
            SecuGenFingerprintImpl(context)
        } catch (e: Exception) {
            fallback("Failed to create SecuGen reader", e)
        } catch (e: NoClassDefFoundError) {
            fallback("SecuGen SDK not available", e)
        }
    }

    private fun fallback(reason: String, e: Throwable): IFingerprintCapture {
        return if (BuildConfig.DEBUG) {
            Log.e(TAG, "$reason; debug build, using MOCK reader", e)
            MockFingerprintImpl()
        } else {
            Log.e(TAG, "$reason; fingerprint reader unavailable", e)
            UnavailableFingerprintImpl()
        }
    }
}

/** Reader used when no real scanner can be created: every operation fails. */
class UnavailableFingerprintImpl : IFingerprintCapture {
    override suspend fun initializeDevice(): Boolean = false
    override suspend fun captureFingerprint(): ByteArray? = null
    override suspend fun closeDevice() {}
    override suspend fun matchTemplates(template1: ByteArray, template2: ByteArray): Boolean = false
    override fun getImplementationType(): String = "UNAVAILABLE"
}

/** Thrown when fingerprint comparison itself fails, so a duplicate check can't be trusted. */
class FingerprintMatchException(message: String) : Exception(message)
