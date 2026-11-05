/**
 * The oldest tablet app this server needs, sent to tablets in
 * GET /api/sync/survey/version (min_app_version_code / min_app_version).
 * Tablets older than this show an "update the SALT app" message after login;
 * nothing is blocked.
 *
 * Raise it when the server starts relying on something new in the tablet app,
 * and make sure versionCode in salt_android/app/build.gradle.kts is at least
 * this (a unit test checks). Matches the Android versionCode / versionName.
 *
 *   4 (1.4): "other, specify" options, built-in JEXL variables
 *            (_facility_name, _facility_id, _is_seed), sqlcipher-android
 */
const MIN_TABLET_VERSION_CODE = 4;
const MIN_TABLET_VERSION_NAME = '1.4';

module.exports = { MIN_TABLET_VERSION_CODE, MIN_TABLET_VERSION_NAME };
