package com.dev.salt.ui

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.dev.salt.BuildConfig
import com.dev.salt.R
import com.dev.salt.debug.DeveloperSettingsManager
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.logging.AppLogger
import com.dev.salt.logging.LogUploadManager
import com.dev.salt.upload.UploadResult
import kotlinx.coroutines.launch

/**
 * Developer settings screen for debug and development options.
 * Currently supports:
 * - Debug Conditional Statements: Shows JEXL debug dialog for skip logic testing
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeveloperSettingsScreen(
    navController: NavController
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var jexlDebugEnabled by remember {
        mutableStateOf(DeveloperSettingsManager.isJexlDebugEnabled(context))
    }

    // Logging preferences. Default = BuildConfig.DEBUG so the switches read
    // OFF on a fresh production build and ON in debug builds, matching
    // AppLogger's own defaults.
    val prefs = remember { context.getSharedPreferences("dev_settings", android.content.Context.MODE_PRIVATE) }
    var fileLoggingEnabled by remember {
        mutableStateOf(prefs.getBoolean("file_logging_enabled", BuildConfig.DEBUG))
    }
    var logcatEnabled by remember {
        mutableStateOf(prefs.getBoolean("logcat_enabled", BuildConfig.DEBUG))
    }

    // Log upload state
    var isUploading by remember { mutableStateOf(false) }
    var logSize by remember { mutableStateOf(0L) }
    var uploadResult by remember { mutableStateOf<UploadResult?>(null) }

    val logUploadManager = remember {
        LogUploadManager(context, SurveyDatabase.getInstance(context))
    }

    // Load log size
    LaunchedEffect(Unit) {
        logSize = AppLogger.getCurrentLogSize()
    }

    fun uploadLogs() {
        scope.launch {
            isUploading = true
            uploadResult = logUploadManager.uploadLogs()
            isUploading = false
            logSize = AppLogger.getCurrentLogSize() // Refresh
        }
    }

    fun clearLogs() {
        AppLogger.clearLogs()
        logSize = 0L
    }

    fun formatBytes(bytes: Long): String {
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "${bytes / 1024} KB"
            else -> "${bytes / (1024 * 1024)} MB"
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.dev_settings_title)) },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(
                            Icons.Default.ArrowBack,
                            contentDescription = stringResource(R.string.cd_back)
                        )
                    }
                }
            )
        }
    ) { paddingValues ->
        // Scrollable so the bottom buttons (e.g. Clear logs) stay reachable in landscape.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Warning card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
                )
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Default.Warning,
                        contentDescription = "Warning",
                        tint = MaterialTheme.colorScheme.error
                    )
                    Column {
                        Text(
                            text = stringResource(R.string.dev_settings_warning_title),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.error
                        )
                        Text(
                            text = stringResource(R.string.dev_settings_warning_body),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                        )
                    }
                }
            }

            // Debug Conditional Statements toggle
            Card(
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_title),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                        )
                    }
                    Spacer(modifier = Modifier.width(16.dp))
                    Switch(
                        checked = jexlDebugEnabled,
                        onCheckedChange = { enabled ->
                            jexlDebugEnabled = enabled
                            DeveloperSettingsManager.setJexlDebugEnabled(context, enabled)
                        }
                    )
                }
            }

            // Info card about what the dialog shows
            if (jexlDebugEnabled) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)
                    )
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_info_header),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_info_context),
                            style = MaterialTheme.typography.bodySmall
                        )
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_info_statement),
                            style = MaterialTheme.typography.bodySmall
                        )
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_info_result),
                            style = MaterialTheme.typography.bodySmall
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.dev_settings_jexl_info_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                        )
                    }
                }
            }

            // Divider
            HorizontalDivider()

            // Development Logs Section
            Text(
                text = stringResource(R.string.dev_settings_logs_section),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = stringResource(R.string.dev_settings_logs_default_note),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )

            // File logging toggle
            Card(
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(
                            text = stringResource(R.string.dev_settings_file_logging),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.dev_settings_file_logging_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                        )
                    }
                    Spacer(modifier = Modifier.width(16.dp))
                    Switch(
                        checked = fileLoggingEnabled,
                        onCheckedChange = { enabled ->
                            fileLoggingEnabled = enabled
                            prefs.edit().putBoolean("file_logging_enabled", enabled).apply()
                            AppLogger.updateSettings(context)
                        }
                    )
                }
            }

            // Logcat toggle
            Card(
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(
                            text = stringResource(R.string.dev_settings_logcat),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.dev_settings_logcat_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                        )
                    }
                    Spacer(modifier = Modifier.width(16.dp))
                    Switch(
                        checked = logcatEnabled,
                        onCheckedChange = { enabled ->
                            logcatEnabled = enabled
                            prefs.edit().putBoolean("logcat_enabled", enabled).apply()
                            AppLogger.updateSettings(context)
                        }
                    )
                }
            }

            // Log size info card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            ) {
                Column(
                    modifier = Modifier.padding(16.dp)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Info,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = stringResource(R.string.dev_settings_log_status),
                            style = MaterialTheme.typography.titleMedium
                        )
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    Text(stringResource(R.string.dev_settings_log_size, formatBytes(logSize)))
                    Text(
                        text = stringResource(R.string.dev_settings_log_auto_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Upload button
            Button(
                onClick = { uploadLogs() },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isUploading && logSize > 0
            ) {
                if (isUploading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(stringResource(R.string.dev_settings_uploading))
                } else {
                    Icon(Icons.Default.Upload, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(stringResource(R.string.dev_settings_upload_button))
                }
            }

            // Clear logs button
            OutlinedButton(
                onClick = { clearLogs() },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isUploading && logSize > 0
            ) {
                Icon(Icons.Default.Delete, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text(stringResource(R.string.dev_settings_clear_button))
            }

            // Upload result dialog
            if (uploadResult != null) {
                AlertDialog(
                    onDismissRequest = { uploadResult = null },
                    title = {
                        Text(
                            text = when (uploadResult) {
                                is UploadResult.Success -> stringResource(R.string.dev_settings_upload_success_title)
                                else -> stringResource(R.string.dev_settings_upload_failed_title)
                            }
                        )
                    },
                    text = {
                        Text(
                            text = when (uploadResult) {
                                is UploadResult.Success -> stringResource(R.string.dev_settings_upload_success_msg)
                                is UploadResult.NetworkError -> (uploadResult as UploadResult.NetworkError).message
                                is UploadResult.ServerError -> {
                                    val error = uploadResult as UploadResult.ServerError
                                    stringResource(R.string.dev_settings_server_error, error.code, error.message)
                                }
                                is UploadResult.ConfigurationError -> (uploadResult as UploadResult.ConfigurationError).message
                                is UploadResult.UnknownError -> (uploadResult as UploadResult.UnknownError).message
                                else -> stringResource(R.string.dev_settings_unknown_error)
                            }
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = { uploadResult = null }) {
                            Text(stringResource(R.string.common_ok))
                        }
                    }
                )
            }
        }
    }
}
