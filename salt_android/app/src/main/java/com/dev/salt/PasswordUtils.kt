package com.dev.salt


import com.dev.salt.logging.AppLogger as Log
import java.security.SecureRandom
import java.security.spec.KeySpec
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import java.util.Base64

object PasswordUtils {

    private const val ALGORITHM = "PBKDF2WithHmacSHA1"
    private const val ITERATION_COUNT = 10000 // NIST recommends at least 10,000 for PBKDF2
    private const val KEY_LENGTH = 256 // In bits
    private const val SALT_LENGTH_BYTES = 16 // 128 bits is a common and good salt length

    /**
     * Hashes a password with a newly generated random salt.
     *
     * @param password The plain text password to hash.
     * @return A string in the format "saltBase64:hashedPasswordBase64",
     *         or null if hashing fails.
     */
    fun hashPasswordWithNewSalt(password: String): String? {
        return try {
            val random = SecureRandom()
            val salt = ByteArray(SALT_LENGTH_BYTES)
            random.nextBytes(salt) // Generate a new random salt

            val spec: KeySpec = PBEKeySpec(password.toCharArray(), salt, ITERATION_COUNT, KEY_LENGTH)
            val factory = SecretKeyFactory.getInstance(ALGORITHM)
            val hashedBytes = factory.generateSecret(spec).encoded

            val saltBase64 = Base64.getEncoder().encodeToString(salt)
            val hashedBase64 = Base64.getEncoder().encodeToString(hashedBytes)

            "$saltBase64:$hashedBase64"
        } catch (e: Exception) {
            Log.e("PasswordUtils", "Error hashing password with new salt", e)
            null // Or throw a custom exception
        }
    }

    /**
     * Verifies a plain text password against a stored salt and hash.
     *
     * @param plainPassword The password entered by the user.
     * @param storedPasswordFormat The string retrieved from the database,
     *                             expected in "saltBase64:hashedPasswordBase64" format.
     * @return True if the password matches, false otherwise.
     */
    fun verifyPassword(plainPassword: String, storedPasswordFormat: String): Boolean {
        return try {
            val parts = storedPasswordFormat.split(":")
            if (parts.size != 2) {
                Log.w("PasswordUtils", "Invalid stored password format. Expected 'salt:hash'.")
                return false
            }
            val saltBase64 = parts[0]
            val storedHashBase64 = parts[1]

            val salt = Base64.getDecoder().decode(saltBase64)
            // val storedHash = Base64.getDecoder().decode(storedHashBase64) // Not needed for comparison here

            val spec: KeySpec = PBEKeySpec(plainPassword.toCharArray(), salt, ITERATION_COUNT, KEY_LENGTH)
            val factory = SecretKeyFactory.getInstance(ALGORITHM)
            val generatedHashedBytes = factory.generateSecret(spec).encoded
            val generatedHashedBase64 = Base64.getEncoder().encodeToString(generatedHashedBytes)
            // Compare the newly generated hash (using the stored salt) with the stored hash
            generatedHashedBase64 == storedHashBase64
        } catch (e: Exception) {
            Log.e("PasswordUtils", "Error verifying password", e)
            false
        }
    }
}