---
title: First Steps
description: Configure your first facility, connect a tablet, and collect your first survey response.
---

This guide walks you through the minimum steps to go from a fresh SALT installation to collecting your first survey response.

## 1. Log in and choose your password

Browse to your server URL and sign in as `admin` with the one-time password the installer printed.

SALT asks you to choose your own password (at least 12 characters) before anything else.

## 2. Review your facilities

The installation seeds one **Demo Facility**. Go to **Facilities** in the navigation to see it.

To create a real facility:
1. Click **Add Facility**
2. Enter the facility name and location
3. Set the number of coupons per participant (typically 3)
4. Configure payment type and amounts
5. Click **Save**

![Facilities list showing Demo Facility](../../../assets/screenshots/admin-facilities-list.png)

## 3. Configure a survey

A complete **Short MSM Survey** is seeded and set to **active**. If this survey meets your needs, you can skip this step for now.

To review or modify the active survey, go to **Surveys** and click the survey name to open the editor.

![Survey list showing seeded surveys](../../../assets/screenshots/admin-surveys-list.png)

## 4. Get the tablet setup code

Before connecting a tablet:

1. Go to **Facilities**
2. Click **Setup Code** next to your facility
3. Note the 6-character code; it expires in 24 hours.

![Facility setup code dialog](../../../assets/screenshots/admin-facilities-setup-code.png)

## 5. Install the tablet app

On the tablet, open a browser and go to `https://your-server/tablet`. This page is public, no credentials required, and provides the APK download and installation instructions.

![/tablet page with installation instructions](../../../assets/screenshots/tablet-apk-download.png)

Follow the instructions on the page (you may need to enable installation from unknown sources in Android Settings → Security).

## 6. Set up the tablet

Open the SALT app on the tablet and follow the setup wizard:

1. **Server Configuration**: enter your server URL (e.g. `https://your-domain.example.org`)
2. **Enter setup code**: type the 6-character code from step 4
3. **Create admin account**: set a username, full name, and password for the tablet administrator
4. **Fingerprint enrollment**: enrol the administrator's fingerprint (or skip to use password-only authentication)

The tablet will download the active survey and facility configuration from the server.

See [Tablet Setup](/tablet/setup/) for detailed instructions.

## 7. Create a staff user

Surveys can only be conducted by **SURVEY_STAFF** users; administrators cannot conduct surveys directly. On the tablet:

1. Log in as the administrator
2. Tap **Manage Users**
3. Tap **+** to add a new user
4. Enter username, full name, password, and set role to **SURVEY_STAFF**
5. Tap **Add User**

Alternatively, survey staff can also be created from the tablet admin dashboard.

## 8. Conduct a test survey

Log out of the admin account and log in as the staff user you just created. Tap **Start New Survey** and walk through the eligibility questions and survey interview. At the end, approve payment and submit.

The completed survey will upload to the management server automatically when the tablet is online. Check **Uploads** in the management dashboard to confirm it arrived.

## Next steps

- [Facilities](/management/facilities/): configure recruitment windows, payment types, coupon limits
- [Survey Questions](/management/survey-questions/): add or modify questions
- [Survey Logic](/management/survey-logic/): skip logic, validation, and eligibility conditions
- [Export Data](/management/export-data/): download data in wide, long, or RDS format
