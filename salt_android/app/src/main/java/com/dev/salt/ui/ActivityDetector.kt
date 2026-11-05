package com.dev.salt.ui

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import com.dev.salt.session.SessionManagerInstance
import com.dev.salt.data.SurveyDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

@Composable
fun ActivityDetector(
    content: @Composable () -> Unit
) {
    val sessionManager = SessionManagerInstance.instance
    val context = LocalContext.current
    val userDao = remember { SurveyDatabase.getInstance(context).userDao() }

    // Observe the session so the effect below re-runs when it becomes active.
    val sessionState by sessionManager.sessionState.collectAsState()

    LaunchedEffect(sessionState.isActive) {
        // Update activity time when session becomes active or user activity is detected
        if (sessionState.isActive) {
            val currentUser = sessionManager.getCurrentUser()
            if (currentUser != null) {
                withContext(Dispatchers.IO) {
                    userDao.updateUserActivity(currentUser, System.currentTimeMillis())
                }
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        // Extend session on user activity
                        if (sessionManager.isSessionActive()) {
                            sessionManager.extendSession()
                            
                            // Update activity time in database
                            val currentUser = sessionManager.getCurrentUser()
                            if (currentUser != null) {
                                GlobalScope.launch(Dispatchers.IO) {
                                    userDao.updateUserActivity(currentUser, System.currentTimeMillis())
                                }
                            }
                        }
                    }
                )
            }
    ) {
        content()
    }
}