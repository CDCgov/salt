package com.dev.salt.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.painterResource
import androidx.navigation.NavController
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.fingerprint.FingerprintManager
import com.dev.salt.data.UserDao
import kotlinx.coroutines.launch
import com.dev.salt.logging.AppLogger as Log
import android.content.Context
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.dev.salt.R
import com.dev.salt.AppDestinations

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StaffFingerprintEnrollmentScreen(
    navController: NavController,
    userName: String
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val userDao = remember { database.userDao() }
    val fingerprintManager = remember { FingerprintManager(database.subjectFingerprintDao(), context) }
    val scope = rememberCoroutineScope()

    var isCapturing by remember { mutableStateOf(false) }
    var enrollmentComplete by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showSkipDialog by remember { mutableStateOf(false) }
    var retryCount by remember { mutableStateOf(0) }

    // Load user info
    var userFullName by remember { mutableStateOf("") }
    LaunchedEffect(userName) {
        val user = userDao.getUserByUserName(userName)
        userFullName = user?.fullName ?: userName
    }

    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = "Fingerprint Enrollment",
                navController = navController,
                showBackButton = false,
                showHomeButton = true,
                requireStaffAuthToLeave = false // staff-only screen
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (!enrollmentComplete) {
                // Compact header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = Icons.Default.Fingerprint,
                        contentDescription = "Fingerprint",
                        modifier = Modifier.size(48.dp),
                        tint = MaterialTheme.colorScheme.primary
                    )
                    Spacer(modifier = Modifier.width(16.dp))
                    Column {
                        Text(
                            text = "Enroll Fingerprint",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = userFullName,
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                // Image and Instructions side by side
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Fingerprint instruction image
                    Image(
                        painter = painterResource(id = R.drawable.fingerprint_instruction),
                        contentDescription = "Place right index finger on scanner",
                        modifier = Modifier
                            .weight(0.4f)
                            .padding(vertical = 8.dp)
                    )

                    // Instructions
                    Column(
                        modifier = Modifier
                            .weight(0.6f)
                            .padding(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            text = "Instructions:",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        StaffInstructionStep(1, "Clean your RIGHT INDEX finger")
                        StaffInstructionStep(2, "Place finger flat on scanner")
                        StaffInstructionStep(3, "Press gently - not too hard")
                        StaffInstructionStep(4, "Hold still until scan completes")
                    }
                }

                // Error message
                errorMessage?.let { message ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer
                        )
                    ) {
                        Text(
                            text = message,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(16.dp),
                            textAlign = TextAlign.Center
                        )
                    }
                }

                // Buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Skip button
                    OutlinedButton(
                        onClick = { showSkipDialog = true },
                        modifier = Modifier.weight(1f),
                        enabled = !isCapturing
                    ) {
                        Text("Skip")
                    }

                    // Enroll button
                    Button(
                        onClick = {
                            scope.launch {
                                isCapturing = true
                                errorMessage = null

                                Log.i("StaffFingerprint", "Starting fingerprint enrollment for $userName")

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
                                    Log.e("StaffFingerprint", "No SecuGen device found")
                                    errorMessage = "Fingerprint scanner not connected. Please connect the device and try again."
                                    isCapturing = false
                                    return@launch
                                }

                                if (!usbManager.hasPermission(secugenDevice)) {
                                    Log.i("StaffFingerprint", "Requesting USB permission")

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
                                    errorMessage = "Please grant USB permission and try again."
                                    isCapturing = false
                                    return@launch
                                }

                                // Initialize device
                                if (!fingerprintManager.initializeDevice()) {
                                    Log.e("StaffFingerprint", "Device initialization failed")
                                    errorMessage = "Failed to initialize fingerprint scanner"
                                    isCapturing = false
                                    return@launch
                                }

                                // Capture fingerprint
                                val fingerprintTemplate = fingerprintManager.captureFingerprint()

                                if (fingerprintTemplate == null) {
                                    Log.e("StaffFingerprint", "Capture failed")
                                    retryCount++
                                    if (retryCount >= 3) {
                                        errorMessage = "Failed to capture fingerprint after 3 attempts"
                                        retryCount = 0
                                    } else {
                                        errorMessage = "Low quality scan. Please try again (Attempt $retryCount of 3)"
                                    }
                                    fingerprintManager.closeDevice()
                                    isCapturing = false
                                    return@launch
                                }

                                Log.i("StaffFingerprint", "Fingerprint captured successfully, saving to database")

                                // Update user with fingerprint template
                                val user = userDao.getUserByUserName(userName)
                                if (user != null) {
                                    val updatedUser = user.copy(
                                        fingerprintTemplate = fingerprintTemplate,
                                        biometricEnabled = true,
                                        biometricEnrolledDate = System.currentTimeMillis()
                                    )
                                    userDao.updateUser(updatedUser)
                                    Log.i("StaffFingerprint", "User fingerprint saved successfully")
                                    enrollmentComplete = true
                                } else {
                                    Log.e("StaffFingerprint", "User not found: $userName")
                                    errorMessage = "User not found"
                                }

                                fingerprintManager.closeDevice()
                                isCapturing = false
                            }
                        },
                        modifier = Modifier.weight(1f),
                        enabled = !isCapturing
                    ) {
                        if (isCapturing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                        } else {
                            Text("Enroll Fingerprint")
                        }
                    }
                }
            } else {
                // Success UI
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                    modifier = Modifier.fillMaxSize()
                ) {
                    Icon(
                        imageVector = Icons.Default.CheckCircle,
                        contentDescription = "Success",
                        modifier = Modifier
                            .size(120.dp)
                            .padding(bottom = 24.dp),
                        tint = MaterialTheme.colorScheme.primary
                    )

                    Text(
                        text = "Fingerprint Enrolled Successfully!",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(bottom = 16.dp)
                    )

                    Text(
                        text = "$userFullName can now login using their fingerprint",
                        style = MaterialTheme.typography.bodyLarge,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(bottom = 32.dp)
                    )

                    Button(
                        onClick = {
                            navController.navigate(AppDestinations.USER_MANAGEMENT) {
                                popUpTo(AppDestinations.USER_MANAGEMENT) { inclusive = true }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(0.6f)
                    ) {
                        Text("Done")
                    }
                }
            }
        }
    }

    // Skip confirmation dialog
    if (showSkipDialog) {
        AlertDialog(
            onDismissRequest = { showSkipDialog = false },
            title = { Text("Skip Fingerprint Enrollment?") },
            text = {
                Text("The user will need to use their password to login. You can enroll their fingerprint later from User Management.")
            },
            confirmButton = {
                Button(
                    onClick = {
                        navController.navigate(AppDestinations.USER_MANAGEMENT) {
                            popUpTo(AppDestinations.USER_MANAGEMENT) { inclusive = true }
                        }
                    }
                ) {
                    Text("Skip")
                }
            },
            dismissButton = {
                TextButton(onClick = { showSkipDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
fun StaffInstructionStep(number: Int, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Card(
            modifier = Modifier.size(24.dp),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primary
            )
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.fillMaxSize()
            ) {
                Text(
                    text = number.toString(),
                    color = MaterialTheme.colorScheme.onPrimary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        Spacer(modifier = Modifier.width(8.dp))

        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f)
        )
    }
}