---
title: Troubleshooting
description: Common problems and solutions for the SALT tablet app and management server.
---

## Tablet app

### Fingerprint scanner not detected

**Symptom**: The scanner does not appear in Scanner Status; the fingerprint prompt does not appear during setup or enrollment.

**Solutions**:
1. Ensure the scanner is connected before opening the SALT app. Connect, then reopen the app.
2. Check that a USB OTG adapter is being used, the SecuGen HU20-A connects via USB-A, which requires an OTG adapter on most modern tablets.
3. When Android asks "Allow SALT to access the USB device?", tap **OK**. If you missed this prompt, disconnect and reconnect the scanner.
4. Go to **Developer Settings** on the tablet and check that no USB permission errors appear in the log.
5. Try a different USB OTG cable or adapter.
6. Restart the tablet with the scanner already connected.

### Audio not playing

**Symptom**: Questions display but no audio is heard.

**Solutions**:
1. Check the tablet volume; it may be muted.
2. Verify that audio was recorded for the active survey's language on the management server (Surveys → Languages → listen to recordings).
3. Ensure the tablet has completed a sync after audio was recorded. Audio is downloaded during sync, not at upload time.
4. Check **Survey Status** to confirm the survey downloaded successfully.

### Cannot connect to the server

**Symptom**: "Cannot reach server" or connection timeout during setup or sync.

**Solutions**:
1. Confirm the tablet is on the same network as the server (or that the server is reachable from the tablet's network).
2. Try opening the server URL in the tablet's browser to confirm it loads.
3. Check that you are using `https://` for production or `http://` for local testing, a mismatch will fail.
4. If using a local network IP, confirm the server is listening on all interfaces (not just `127.0.0.1`).
5. Check the server is running: `docker logs -f salt`.

### Upload failed

**Symptom**: Survey Status shows failed uploads. The management server Uploads page shows `status: failed`.

**Solutions**:
1. Check the error detail on the Uploads page for the specific rejection reason.
2. Common cause: survey version mismatch. Force a sync on the tablet (**Server Settings → Sync Now**) to download the latest survey.
3. Common cause: duplicate participant ID with fingerprint screening disabled. Investigate whether the same person was enrolled twice.
4. If the upload JSON is corrupt, download the raw payload from the Uploads page and inspect it.

### App crashes or freezes

**Solutions**:
1. Enable **File Logging** in Developer Settings, reproduce the crash, then upload the development logs to the server for inspection.
2. Check available storage on the tablet, the encrypted database can grow large with many completed surveys.
3. Force-stop the app (Android Settings → Apps → SALT → Force Stop) and reopen it.
4. If crashes persist, check the management server for APK updates.

### Login fails

**Symptom**: Correct username and password are rejected.

**Solutions**:
1. Passwords are case-sensitive, check Caps Lock is not on.
2. If the administrator password is unknown, another administrator must reset it via **Manage Users → Edit User**.
3. If all administrator passwords are lost, the database must be reset. Contact the server administrator to re-run the tablet setup.

### "Update the SALT app" message after login

**Symptom**: After logging in, the tablet says its SALT app version is older than the server needs.

**Cause**: The server has been updated and relies on features of a newer tablet app. The tablet keeps working after you tap **OK**, but some survey features may not work correctly until it is updated.

**Solution**: Install the current app from the address shown in the message (the server's `/tablet` page), following [Tablet Setup](../../tablet/setup/). Installing over the existing app keeps the tablet's data. The message stops once the tablet has the version the server needs. It only appears when the tablet can reach the server.

---

## Management server

### Container won't start

```bash
docker logs salt
```

Common cause: a port conflict on 3000. Change the host-side port in the `-p` flag.

### Cannot reach the web UI

By default `docker-compose.yml` binds to `127.0.0.1`. Either run `setup-nginx.sh` for proper TLS termination, or change the bind address to `0.0.0.0:3000` for plain HTTP exposure (not recommended in production).

### `/files/salt.apk` returns 404

The APK is served from `data/files/`. Copy it manually:

```bash
cp salt-new.apk /opt/salt/salt-data/files/salt.apk
```

No restart is needed.

### Audio recording not working in the survey editor

Audio recording requires an **HTTPS** connection. The browser's MediaRecorder API is blocked on plain HTTP in modern browsers. Ensure your server has a valid TLS certificate and you are accessing it over `https://`.

### Survey sync failures on tablets

1. Verify the facility API key on the tablet matches the key shown in Facilities on the server.
2. Check network connectivity between the tablet and server.
3. Review server logs: `docker logs -f salt`.

### "Failed to save: undefined" error in survey editor

1. Check the browser console (F12 → Console) for the specific error.
2. Verify all required fields in the question edit modal are filled in.
3. Check server logs for validation errors.

### Reset the admin password

```bash
docker exec -it salt sqlite3 /app/data/database/salt.db \
  "DELETE FROM admin_users WHERE username='admin';"
docker exec salt node scripts/init-database.js
```

This recreates the `admin` / `admin123` account. Log in and change the password immediately.
