package com.dev.salt.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dev.salt.R

/**
 * A reusable button that returns to the main menu (staff or admin) with a confirmation dialog.
 * Shows a warning about unsaved changes before navigating.
 *
 * @param onReturnToMenu Callback to navigate back to the appropriate main menu
 * @param modifier Optional modifier for the button
 * @param isVisible Whether the button should be visible (default true)
 * @param requireStaffAuth If true, a staff member must authenticate (fingerprint
 *   or username/password) before leaving, instead of a plain confirmation. Used
 *   on screens a participant may be holding.
 */
@Composable
fun ReturnToMenuButton(
    onReturnToMenu: () -> Unit,
    modifier: Modifier = Modifier,
    isVisible: Boolean = true,
    requireStaffAuth: Boolean = false
) {
    var showConfirmDialog by remember { mutableStateOf(false) }

    if (isVisible) {
        OutlinedButton(
            onClick = { showConfirmDialog = true },
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = MaterialTheme.colorScheme.primary
            ),
            modifier = modifier
        ) {
            Icon(
                Icons.Default.Home,
                contentDescription = stringResource(R.string.cd_return_to_menu),
                modifier = Modifier.size(18.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(stringResource(R.string.return_to_menu_button))
        }
    }

    if (showConfirmDialog && requireStaffAuth) {
        StaffAuthDialog(
            title = stringResource(R.string.leave_survey_auth_title),
            message = stringResource(R.string.leave_survey_auth_message),
            onAuthenticated = {
                showConfirmDialog = false
                onReturnToMenu()
            },
            onDismiss = { showConfirmDialog = false }
        )
    } else if (showConfirmDialog) {
        ReturnToMenuConfirmDialog(
            onConfirm = {
                showConfirmDialog = false
                onReturnToMenu()
            },
            onDismiss = { showConfirmDialog = false }
        )
    }
}

@Composable
fun ReturnToMenuConfirmDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Icon(
                    Icons.Default.Warning,
                    contentDescription = stringResource(R.string.common_warning),
                    tint = MaterialTheme.colorScheme.error
                )
                Text(stringResource(R.string.return_to_menu_confirm_title))
            }
        },
        text = {
            Text(
                text = stringResource(R.string.return_to_menu_confirm_message),
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Start
            )
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error
                )
            ) {
                Text(stringResource(R.string.return_to_menu_confirm_button))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    )
}
