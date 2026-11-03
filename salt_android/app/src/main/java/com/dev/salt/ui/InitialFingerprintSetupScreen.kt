package com.dev.salt.ui

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import com.dev.salt.logging.AppLogger as Log
import android.content.Context
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.dev.salt.R
import com.dev.salt.PasswordUtils
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.data.User
import com.dev.salt.fingerprint.FingerprintManager
import kotlinx.coroutines.launch

/**
 * Initial fingerprint setup screen for admin user during first-time setup wizard.
 *
 * Captures fingerprint template for the admin user and creates the user account
 * in the database. This is the third and final step in the setup wizard before
 * proceeding to facility configuration.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InitialFingerprintSetupScreen(
    username: String,
    fullName: String,
    password: String,
    onSetupComplete: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val database = SurveyDatabase.getInstance(context)
    val fingerprintManager = remember { FingerprintManager(database.subjectFingerprintDao(), context) }

    var captureStatus by remember { mutableStateOf(context.getString(R.string.status_fingerprint_ready)) }
    var fingerprintTemplate by remember { mutableStateOf<ByteArray?>(null) }
    var isCapturing by remember { mutableStateOf(false) }
    var isCreatingUser by remember { mutableStateOf(false) }
    var retryCount by remember { mutableStateOf(0) }

    fun captureFingerprint() {
        scope.launch {
            isCapturing = true
            captureStatus = context.getString(R.string.status_fingerprint_capturing)

            Log.i("InitialFingerprintSetup", "Starting fingerprint enrollment for admin user: $username")

            // Check for USB device and permission
            val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            val deviceList = usbManager.deviceList
            var secugenDevice: UsbDevice? = null

            for ((_, device) in deviceList) {
                if (device.vendorId == 0x1162) { // SecuGen vendor ID
                    secugenDevice = device
                    break
                }
            }

            if (secugenDevice == null) {
                Log.e("InitialFingerprintSetup", "No SecuGen device found")
                captureStatus = context.getString(R.string.error_scanner_not_connected)
                isCapturing = false
                return@launch
            }

            if (!usbManager.hasPermission(secugenDevice)) {
                Log.i("InitialFingerprintSetup", "Requesting USB permission")

                val permissionIntent = PendingIntent.getBroadcast(
                    context,
                    0,
                    Intent("com.dev.salt.USB_PERMISSION").apply {
                        setPackage(context.packageName)
                    },
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        PendingIntent.FLAG_IMMUTABLE
                    } else {
                        0
                    }
                )

                usbManager.requestPermission(secugenDevice, permissionIntent)
                captureStatus = context.getString(R.string.error_usb_permission_required)
                isCapturing = false
                return@launch
            }

            // Initialize device
            if (!fingerprintManager.initializeDevice()) {
                Log.e("InitialFingerprintSetup", "Device initialization failed")
                captureStatus = context.getString(R.string.error_scanner_init_failed)
                isCapturing = false
                return@launch
            }

            // Capture fingerprint
            val template = fingerprintManager.captureFingerprint()

            if (template == null) {
                Log.e("InitialFingerprintSetup", "Capture failed")
                retryCount++
                if (retryCount >= 3) {
                    captureStatus = context.getString(R.string.error_fingerprint_capture_failed_max)
                    retryCount = 0
                } else {
                    captureStatus = context.getString(R.string.error_fingerprint_low_quality, retryCount)
                }
                fingerprintManager.closeDevice()
                isCapturing = false
                return@launch
            }

            Log.i("InitialFingerprintSetup", "Fingerprint captured successfully")
            fingerprintTemplate = template
            captureStatus = context.getString(R.string.status_fingerprint_success)
            fingerprintManager.closeDevice()
            isCapturing = false
        }
    }

    fun completeSetup(skipFingerprint: Boolean = false) {
        if (!skipFingerprint && fingerprintTemplate == null) {
            captureStatus = context.getString(R.string.error_fingerprint_not_captured)
            return
        }

        isCreatingUser = true
        scope.launch {
            try {
                // Hash the password
                val hashedPassword = PasswordUtils.hashPasswordWithNewSalt(password)
                if (hashedPassword == null) {
                    captureStatus = context.getString(R.string.error_password_hash_failed)
                    isCreatingUser = false
                    return@launch
                }

                // Create admin user
                val adminUser = User(
                    userName = username,
                    fullName = fullName,
                    hashedPassword = hashedPassword,
                    role = "ADMINISTRATOR",
                    fingerprintTemplate = if (skipFingerprint) null else fingerprintTemplate,
                    biometricEnabled = !skipFingerprint && fingerprintTemplate != null,
                    sessionTimeoutMinutes = 30,
                    lastLoginTime = System.currentTimeMillis(),
                    lastActivityTime = System.currentTimeMillis()
                )

                // Insert user into database
                database.userDao().insertUser(adminUser)
                Log.d("FingerprintSetup", "Admin user created: $username (fingerprint ${if (skipFingerprint) "skipped" else "enrolled"})")

                // Navigate to facility setup
                onSetupComplete()
            } catch (e: Exception) {
                captureStatus = context.getString(R.string.error_user_creation_failed, e.message ?: "Unknown error")
                isCreatingUser = false
                Log.e("FingerprintSetup", "Error creating user", e)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.setup_fingerprint_title)) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                )
            )
        }
    ) { paddingValues ->
        // Scrollable so the content fits in landscape on tablets; without it the
        // buttons were squeezed off-screen and rendered with no visible labels.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Header
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = stringResource(R.string.setup_fingerprint_header),
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.primary
                )
                Text(
                    text = stringResource(R.string.setup_fingerprint_description),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // User info card
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = stringResource(R.string.label_account_info),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(stringResource(R.string.label_username_display, username))
                    Text(stringResource(R.string.label_fullname_display, fullName))
                    Text(stringResource(R.string.label_role_administrator))
                }
            }

            // Fingerprint capture card
            Card(
                modifier = Modifier.fillMaxWidth(),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = stringResource(R.string.label_fingerprint_scanner),
                        style = MaterialTheme.typography.titleMedium
                    )

                    // Fingerprint instruction image
                    Image(
                        painter = painterResource(id = R.drawable.fingerprint_instruction),
                        contentDescription = "Fingerprint scanner instruction",
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp)
                    )

                    // Status message
                    Text(
                        text = captureStatus,
                        style = MaterialTheme.typography.bodyMedium,
                        color = when {
                            captureStatus.startsWith("✓") -> MaterialTheme.colorScheme.primary
                            captureStatus.startsWith("✗") -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )

                    // Capture button
                    Button(
                        onClick = { captureFingerprint() },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !isCapturing && !isCreatingUser
                    ) {
                        if (isCapturing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                color = MaterialTheme.colorScheme.onPrimary,
                                strokeWidth = 2.dp
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        }
                        Text(if (fingerprintTemplate != null) stringResource(R.string.button_recapture_fingerprint) else stringResource(R.string.button_capture_fingerprint))
                    }

                    // Instructions
                    Text(
                        text = stringResource(R.string.info_fingerprint_instructions),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Action buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Skip fingerprint button
                OutlinedButton(
                    onClick = { completeSetup(skipFingerprint = true) },
                    modifier = Modifier.weight(1f),
                    enabled = !isCapturing && !isCreatingUser
                ) {
                    Text("Skip")
                }

                // Complete setup button
                Button(
                    onClick = { completeSetup(skipFingerprint = false) },
                    modifier = Modifier.weight(1f),
                    enabled = fingerprintTemplate != null && !isCapturing && !isCreatingUser
                ) {
                    if (isCreatingUser) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(stringResource(R.string.status_creating_account))
                    } else {
                        Text("Continue")
                    }
                }
            }

            // Info text about skipping
            Text(
                text = "You can skip fingerprint setup and use password-only authentication. Fingerprint can be enabled later in settings.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
