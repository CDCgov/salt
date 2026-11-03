package com.dev.salt.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.dev.salt.data.SurveyDatabase
import com.dev.salt.util.SeedRecruitmentManager
import kotlinx.coroutines.launch
import androidx.activity.compose.BackHandler

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SeedRecruitmentScreen(navController: NavController) {
    // Disable hardware back button during survey flow
    BackHandler(enabled = true) {
        // Intentionally empty - back button is disabled during survey flow
    }

    val context = LocalContext.current
    val database = remember { SurveyDatabase.getInstance(context) }
    val recruitmentManager = remember { SeedRecruitmentManager(database) }
    val scope = rememberCoroutineScope()
    val clipboardManager = LocalClipboardManager.current
    
    var recruitment by remember { mutableStateOf<com.dev.salt.data.SeedRecruitment?>(null) }
    var facilityName by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showConfirmDialog by remember { mutableStateOf(false) }
    var messageCopied by remember { mutableStateOf(false) }
    
    // Load recruitment data
    LaunchedEffect(Unit) {
        scope.launch {
            isLoading = true
            try {
                // Get facility name
                val facilityConfig = database.facilityConfigDao().getFacilityConfig()
                facilityName = facilityConfig?.facilityName ?: "Our Facility"
                
                // Get or select recruitment subject
                val selectedRecruitment = recruitmentManager.getOrSelectSubject()
                
                if (selectedRecruitment == null) {
                    errorMessage = "No eligible participants found for recruitment at this time."
                } else {
                    recruitment = selectedRecruitment
                }
            } catch (e: Exception) {
                errorMessage = "Error loading recruitment data: ${e.message}"
            } finally {
                isLoading = false
            }
        }
    }
    
    Scaffold(
        topBar = {
            SaltTopAppBar(
                title = "Seed Recruitment",
                navController = navController,
                showBackButton = true,
                showHomeButton = true,
                requireStaffAuthToLeave = false // staff-only screen
            )
        }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            when {
                isLoading -> {
                    CircularProgressIndicator(
                        modifier = Modifier.align(Alignment.Center)
                    )
                }
                
                errorMessage != null -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = errorMessage!!,
                            style = MaterialTheme.typography.bodyLarge,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.error
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(onClick = { navController.navigateUp() }) {
                            Text("Back to Menu")
                        }
                    }
                }
                
                recruitment != null -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(16.dp)
                    ) {
                        // Contact Information Card
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.primaryContainer
                            )
                        ) {
                            Column(
                                modifier = Modifier.padding(16.dp)
                            ) {
                                Text(
                                    text = "Contact Information",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                
                                Text(
                                    text = "Type: ${if (recruitment!!.contactType == "phone") "Phone Number" else "Email"}",
                                    style = MaterialTheme.typography.bodyLarge
                                )
                                Text(
                                    text = recruitment!!.contactInfo,
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.Medium
                                )
                            }
                        }
                        
                        Spacer(modifier = Modifier.height(16.dp))
                        
                        // Recruitment Message Card
                        Card(
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(
                                modifier = Modifier.padding(16.dp)
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = if (recruitment!!.contactType == "phone") "Text Message" else "Email",
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.Bold
                                    )
                                    
                                    IconButton(
                                        onClick = {
                                            val message = recruitmentManager.generateRecruitmentMessage(
                                                recruitment!!,
                                                facilityName
                                            )
                                            clipboardManager.setText(AnnotatedString(message))
                                            messageCopied = true
                                        }
                                    ) {
                                        Icon(
                                            Icons.Default.ContentCopy,
                                            contentDescription = "Copy Message"
                                        )
                                    }
                                }
                                
                                Spacer(modifier = Modifier.height(8.dp))
                                
                                Text(
                                    text = recruitmentManager.generateRecruitmentMessage(
                                        recruitment!!,
                                        facilityName
                                    ),
                                    style = MaterialTheme.typography.bodyMedium
                                )
                                
                                if (messageCopied) {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        text = "✓ Message copied to clipboard",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary
                                    )
                                }
                            }
                        }
                        
                        Spacer(modifier = Modifier.height(16.dp))
                        
                        // Coupon Code Card
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer
                            )
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Text(
                                    text = "Coupon Code",
                                    style = MaterialTheme.typography.titleMedium
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    text = recruitment!!.couponCode,
                                    style = MaterialTheme.typography.headlineLarge,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                        
                        Spacer(modifier = Modifier.height(24.dp))
                        
                        // Action Buttons
                        if (!recruitment!!.messageSent) {
                            Text(
                                text = "Did you send the recruitment message?",
                                style = MaterialTheme.typography.bodyLarge,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth()
                            )
                            
                            Spacer(modifier = Modifier.height(16.dp))
                            
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceEvenly
                            ) {
                                OutlinedButton(
                                    onClick = { navController.navigateUp() },
                                    modifier = Modifier.weight(1f).padding(end = 8.dp)
                                ) {
                                    Text("Cancel")
                                }
                                
                                Button(
                                    onClick = { showConfirmDialog = true },
                                    modifier = Modifier.weight(1f).padding(start = 8.dp)
                                ) {
                                    Icon(
                                        Icons.Default.Send,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("Message Sent")
                                }
                            }
                        } else {
                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Text(
                                    text = "✓ Recruitment message has been sent",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.primary,
                                    textAlign = TextAlign.Center
                                )
                                Spacer(modifier = Modifier.height(16.dp))
                                Button(
                                    onClick = { navController.navigateUp() },
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text("Back to Menu")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Confirmation Dialog
    if (showConfirmDialog) {
        AlertDialog(
            onDismissRequest = { showConfirmDialog = false },
            title = { Text("Confirm Message Sent") },
            text = {
                Text("Please confirm that you have sent the recruitment message to ${recruitment?.contactInfo}")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch {
                            recruitment?.let {
                                recruitmentManager.markMessageSent(it.id)
                                showConfirmDialog = false
                                navController.navigateUp()
                            }
                        }
                    }
                ) {
                    Text("Confirm")
                }
            },
            dismissButton = {
                TextButton(onClick = { showConfirmDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}