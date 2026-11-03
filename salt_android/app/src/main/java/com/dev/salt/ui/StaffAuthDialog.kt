package com.dev.salt.ui

import android.app.PendingIntent
import android.content.Intent
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.dev.salt.PasswordUtils
import com.dev.salt.R
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.fingerprint.IFingerprintCapture
import com.dev.salt.fingerprint.MockFingerprintImpl
import com.dev.salt.fingerprint.SecuGenFingerprintImpl
import com.dev.salt.util.EmulatorDetector
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.dev.salt.logging.AppLogger as Log

private val STAFF_ROLES = setOf("SURVEY_STAFF", "ADMINISTRATOR")

/**
 * Requires a staff member (survey staff or administrator) to authenticate,
 * by fingerprint or by username and password, before [onAuthenticated] runs.
 * Used to stop a participant holding the tablet from leaving the survey flow.
 */
@Composable
fun StaffAuthDialog(
    title: String,
    message: String,
    onAuthenticated: (userName: String) -> Unit,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val scope = rememberCoroutineScope()

    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun authenticateWithFingerprint() {
        scope.launch {
            busy = true
            errorMessage = null
            try {
                val staffUsers = withContext(Dispatchers.IO) {
                    database.userDao().getAllUsers()
                        .filter { it.role in STAFF_ROLES && it.fingerprintTemplate != null }
                }
                if (staffUsers.isEmpty()) {
                    errorMessage = context.getString(R.string.error_no_fingerprints_enrolled)
                    return@launch
                }

                val impl: IFingerprintCapture = if (EmulatorDetector.isEmulator()) {
                    MockFingerprintImpl()
                } else {
                    val usbManager = context.getSystemService(android.content.Context.USB_SERVICE) as UsbManager
                    val device: UsbDevice? = usbManager.deviceList.values.firstOrNull { it.vendorId == 0x1162 } // SecuGen
                    if (device == null) {
                        errorMessage = context.getString(R.string.error_fingerprint_scanner_not_connected)
                        return@launch
                    }
                    if (!usbManager.hasPermission(device)) {
                        val intent = PendingIntent.getBroadcast(
                            context, 0,
                            Intent("com.dev.salt.USB_PERMISSION").apply { setPackage(context.packageName) },
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0
                        )
                        usbManager.requestPermission(device, intent)
                        errorMessage = context.getString(R.string.error_fingerprint_usb_permission)
                        return@launch
                    }
                    SecuGenFingerprintImpl(context)
                }

                if (!impl.initializeDevice()) {
                    errorMessage = context.getString(R.string.error_fingerprint_init_failed)
                    return@launch
                }
                val captured = impl.captureFingerprint()
                if (captured == null) {
                    impl.closeDevice()
                    errorMessage = context.getString(R.string.error_fingerprint_capture_failed)
                    return@launch
                }
                val matched = staffUsers.firstOrNull { user ->
                    user.fingerprintTemplate?.let { impl.matchTemplates(captured, it) } == true
                }
                impl.closeDevice()

                if (matched != null) {
                    Log.i("StaffAuthDialog", "Staff fingerprint authenticated: ${matched.userName}")
                    onAuthenticated(matched.userName)
                } else {
                    errorMessage = context.getString(R.string.leave_survey_fingerprint_no_match)
                }
            } catch (e: Exception) {
                Log.e("StaffAuthDialog", "Fingerprint authentication failed", e)
                errorMessage = context.getString(R.string.error_fingerprint_capture_failed)
            } finally {
                busy = false
            }
        }
    }

    fun authenticateWithPassword() {
        scope.launch {
            busy = true
            errorMessage = null
            val user = withContext(Dispatchers.IO) { database.userDao().getUserByUserName(username.trim()) }
            val ok = user != null && user.role in STAFF_ROLES &&
                withContext(Dispatchers.Default) { PasswordUtils.verifyPassword(password, user.hashedPassword) }
            busy = false
            if (ok) {
                Log.i("StaffAuthDialog", "Staff password authenticated: ${user!!.userName}")
                onAuthenticated(user.userName)
            } else {
                password = ""
                errorMessage = context.getString(R.string.staff_validation_invalid_credentials)
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(message)
                OutlinedButton(
                    onClick = { authenticateWithFingerprint() },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.Fingerprint, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(stringResource(R.string.staff_validation_authenticate_fingerprint))
                }
                Text(stringResource(R.string.staff_validation_use_password), style = MaterialTheme.typography.labelLarge)
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = { Text(stringResource(R.string.login_username)) },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(stringResource(R.string.login_password)) },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth()
                )
                if (busy) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                errorMessage?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { authenticateWithPassword() },
                enabled = !busy && username.isNotBlank() && password.isNotEmpty()
            ) {
                Text(stringResource(R.string.leave_survey_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    )
}
