# SALT Management Server

The SALT Management Server is the central backend for the SALT (System Assisted Link Tracing) system, providing survey configuration, data collection, and facility management capabilities.

**[← Back to Main Documentation](../README.md)**

## Quick Setup

### Option 1: Native Installation (5 minutes)

```bash
# 1. Install prerequisites
# - Node.js 20.17+ (https://nodejs.org/; 22 LTS recommended)
# - SQLite3 (usually pre-installed on macOS/Linux)
# - R 4.0+ (https://cran.r-project.org/) - for data analysis
# - Quarto (https://quarto.org/docs/get-started/) - for reports

# 2. Navigate to server directory
cd salt_management

# 3. Install dependencies
npm install

# 4. Start the server
npm start

# 5. Open browser to http://localhost:3000
# 6. Login with default credentials: admin / admin123
#    IMPORTANT: Change password immediately after first login
```

## Prerequisites

### Required Software

- **Node.js**: Version 14 or higher
  - Download: https://nodejs.org/
  - Verify: `node --version`

- **npm**: Usually comes with Node.js
  - Verify: `npm --version`

- **SQLite3**: Database engine
  - macOS/Linux: Usually pre-installed
  - Windows: Download from https://sqlite.org/download.html
  - Verify: `sqlite3 --version`

- **R**: Version 4.0 or higher (for RDS analysis and data exports)
  - Download: https://cran.r-project.org/
  - Required R packages: DBI, RSQLite, httr, jsonlite, lubridate, scales, uuid, RDS
  - Install packages: `Rscript -e "install.packages(c('DBI', 'RSQLite', 'httr', 'jsonlite', 'lubridate', 'scales', 'uuid', 'RDS'))"`

- **Quarto**: Latest version (for generating reports)
  - Download: https://quarto.org/docs/get-started/
  - Verify: `quarto --version`

---

## Installation

### Step 1: Clone or Download Repository

```bash
# Using git
git clone <repository-url>
cd salt/salt_management

# Or download and extract ZIP file, then navigate to salt_management/
```

### Step 2: Install Node.js Dependencies

```bash
npm install
```

This will install all required packages including:
- Express (web framework)
- SQLite3 (database driver)
- EJS (templating engine)
- Authentication and session management libraries
- Various utility packages


### Step 3: Start the Server

```bash
# Development mode (with auto-restart on file changes)
npm run dev

# Production mode
npm start
```

Server will start on **http://localhost:3000** by default.

## Configuration

### Environment Variables

Create a `.env` file in the `salt_management/` directory:

```bash
# Server Configuration
PORT=3000
NODE_ENV=production

# Database
DATABASE_PATH=./data/database/salt.db

# Session Security
SESSION_SECRET=your-random-secret-here-change-this

# HTTPS Configuration (optional)
HTTPS_ENABLED=false
SSL_CERT_PATH=/path/to/certificate.pem
SSL_KEY_PATH=/path/to/private-key.pem
```

**Important**: Change `SESSION_SECRET` to a random string in production.

### Port Configuration

To run on a different port:

```bash
PORT=8080 npm start
```

Or set it in `.env` file.

### HTTPS Setup

For production deployments, HTTPS is strongly recommended:

1. **Option A: Self-Signed Certificate** (testing/internal use)
   ```bash
   # Generate certificate
   openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

   # Update .env
   HTTPS_ENABLED=true
   SSL_CERT_PATH=/path/to/cert.pem
   SSL_KEY_PATH=/path/to/key.pem
   ```

2. **Option B: Let's Encrypt** (public deployments)
   - Use Certbot or similar tool to obtain certificates
   - Update `.env` with certificate paths

3. **Option C: Reverse Proxy** (recommended for production)
   - Use Nginx or Apache as reverse proxy
   - Handle HTTPS at proxy level
   - Forward to Node.js app on localhost

---

## First-Time Setup

### Step 1: Access Web Interface

1. Open browser to http://localhost:3000
2. You should see the login page

### Step 2: Initial Login

Default credentials:
- **Username**: `admin`
- **Password**: `admin123`

**⚠️ IMPORTANT**: Change this password immediately after first login!

### Step 3: Change Default Password

1. Click on "Users" in the navigation menu
2. Find the admin user
3. Click "Edit"
4. Enter new password
5. Save changes

### Step 4: Create Your First Facility

1. Navigate to "Facilities" from the main menu
2. Click "Add New Facility"
3. Fill in facility details:
   - **Name**: Facility name (e.g., "Main Clinic")
   - **Code**: Short code for identification (e.g., "MC01")
   - **Location**: Physical address or description
4. Click "Create"
5. **Save the API Key** - you'll need this for tablet setup

### Step 5: Upload Your First Survey

1. Navigate to "Surveys" from the main menu
2. Click "Upload Survey"
3. Upload a survey JSON file (or create one using the survey editor)
4. Configure survey settings:
   - Active/inactive status
   - Version number
   - Effective dates
5. Save the survey

**Survey JSON Structure**: See [Survey Configuration](#survey-configuration) for details.

---

## User Management

### User Roles

The system supports two roles:

1. **ADMINISTRATOR**
   - Full system access
   - User management
   - Facility management
   - Survey configuration
   - Data export and analysis

2. **LAB_STAFF**
   - Lab test result entry
   - View assigned participant tests
   - Cannot modify system configuration

### Creating New Users

1. Navigate to "Users" from the admin menu
2. Click "Add New User"
3. Fill in user details:
   - Username (unique)
   - Password (will be hashed)
   - Full name
   - Email address
   - Role (Administrator or Lab Staff)
4. Click "Create User"

### Managing Existing Users

- **Edit User**: Change details, reset password, change role
- **Deactivate User**: Disable access without deleting account
- **Delete User**: Permanently remove user (cannot delete last admin)

### Password Security

- Passwords are hashed using bcrypt with salt
- Minimum password requirements (configure in code if needed)
- Regular password rotation recommended
- Consider implementing two-factor authentication for production

---

## Survey Configuration

### Survey JSON Structure

Surveys are defined in JSON format with the following structure:

```json
{
  "id": 1,
  "name": "HIV Risk Assessment Survey",
  "version": 1,
  "questions": [
    {
      "id": 1,
      "question_text": {
        "en": "Have you been tested for HIV before?",
        "es": "¿Se ha hecho la prueba del VIH antes?"
      },
      "question_audio": {
        "en": "path/to/audio_en.mp3",
        "es": "path/to/audio_es.mp3"
      },
      "question_type": "multiple_choice",
      "short_name": "previous_test",
      "display_order": 1,
      "options": [
        {
          "id": 1,
          "option_text": {
            "en": "Yes",
            "es": "Sí"
          },
          "option_audio": {
            "en": "path/to/yes_en.mp3",
            "es": "path/to/yes_es.mp3"
          },
          "display_order": 1
        },
        {
          "id": 2,
          "option_text": {
            "en": "No",
            "es": "No"
          },
          "display_order": 2
        }
      ]
    }
  ]
}
```

### Question Types

1. **multiple_choice**: Single selection from options
2. **multi_select**: Multiple selections with min/max constraints
3. **numeric**: Numeric input with validation
4. **text**: Free-form text input

### Multi-Language Support

Each question and option can have:
- **Text**: JSON object with language codes as keys
- **Audio**: Optional audio files for ACASI functionality

Supported languages: Configure in survey JSON (e.g., "en", "es", "fr")

### Skip Logic

Use JEXL expressions in the `preScript` field:

```json
{
  "question_text": {"en": "When was your last HIV test?"},
  "preScript": "previous_test == 0",
  "short_name": "last_test_date"
}
```

This question only appears if `previous_test` (previous question's answer) equals 0 (Yes option).

### Validation Scripts

Add custom validation in `validationScript` field:

```json
{
  "question_type": "numeric",
  "question_text": {"en": "What is your age?"},
  "validationScript": "answer >= 18 && answer <= 120",
  "short_name": "age"
}
```

### System Messages

Configure custom messages for different survey stages:

1. Navigate to "Surveys" → Select survey → "System Messages" tab
2. Configure messages for:
   - Staff validation prompts
   - Eligibility screens
   - Payment confirmations
   - Completion messages
3. Add text and audio for each language

### Audio File Management

Audio files should be:
- **Format**: MP3 (recommended) or WAV
- **Quality**: 128kbps minimum for speech
- **Storage**: Place in `/data/audio/` directory
- **Path**: Reference relative to audio directory in JSON

---

## Facility Management

### Facility Configuration

Each facility has:
- **Name**: Full facility name
- **Code**: Short code for identification
- **API Key**: Auto-generated key for tablet authentication
- **Location**: Physical address or description
- **Upload Settings**: Server configuration for data upload
- **Coupon Limits**: Maximum coupons per participant

### Generating Short Codes

For tablet registration:

1. Navigate to "Facilities" → Select facility
2. Click "Generate Short Code"
3. Short code is valid for 24 hours
4. Provide code to tablet user for one-time setup

### Facility API Keys

API keys are automatically generated and used for:
- Tablet authentication
- Survey synchronization
- Data upload
- Configuration retrieval

**Format**: `salt_<uuid>`

**Security**:
- Keys are permanent unless manually regenerated
- Store securely on tablets
- Regenerate if compromised

### Monitoring Facility Activity

View facility statistics:
- Total surveys completed
- Active tablets
- Last sync time
- Upload success rate

---

## Lab Test Configuration

### Overview

The lab test system manages laboratory results for survey participants, particularly for HIV testing workflows (rapid tests → viral load confirmation).

### Creating Lab Tests

1. Navigate to "Lab Tests" from the admin menu
2. Click "Add New Test"
3. Fill in test details:

**For Numeric Tests** (e.g., Viral Load):
- Test Name: "Viral Load"
- Test Code: "VL"
- Type: Numeric
- Unit: "copies/mL"
- Min Value: 0 (optional)
- Max Value: 1000000 (optional)
- Display Order: 1

**For Dropdown Tests** (e.g., Blood Type):
- Test Name: "Blood Type"
- Test Code: "BT"
- Type: Dropdown
- Options: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]
- Display Order: 2

### Entering Lab Results

1. Navigate to "Enter Lab Results" (from Lab Tests page)
2. Search for participant by ID or name
3. Select test type from dropdown
4. Enter result value
5. Save result

Results are timestamped and linked to the submitting user for audit trail.

### Managing Lab Tests

- **Edit Test**: Modify test parameters (affects future results only)
- **Activate/Deactivate**: Enable or disable tests from result entry
- **Delete Test**: Only possible if no results exist
- **Filter Tests**: By type (numeric/dropdown) or status (active/inactive)

### Lab Results Workflow

Typical HIV testing workflow:
1. Participant completes survey with rapid test
2. If rapid test positive → sample collected
3. Lab technician receives sample with participant ID
4. Lab runs viral load test
5. Lab staff enters result in system via "Enter Lab Results"
6. Result linked to participant record for analysis

---

## Data Export

### Export Formats

The system supports multiple export formats:

#### 1. Wide Format (One row per survey)

```bash
# Navigate to: Export Data → Wide Format
```

Columns:
- Participant demographics
- One column per question (using short names)
- Survey metadata (completion time, facility, etc.)

Best for: Basic analysis in spreadsheet software

#### 2. Long Format (One row per answer)

```bash
# Navigate to: Export Data → Long Format
```

Columns:
- survey_id
- participant_id
- question_short_name
- answer_value
- timestamp

Best for: Advanced statistical analysis, database import

#### 3. RDS Format (For Respondent-Driven Sampling analysis)

Includes:
- Recruitment chains (coupon linkages)
- Network data
- Sampling weights
- Required columns for RDS R package

### Exporting Data via Web Interface

1. Navigate to "Export Data" from the main menu
2. Select export format
3. Apply filters (optional):
   - Date range
   - Facility
   - Survey version
4. Click "Export to CSV"
5. Download file

### Exporting via R Scripts

For automated exports and analysis:

```r
# Install required packages
install.packages(c("DBI", "RSQLite", "RDS"))

# Connect to database
library(DBI)
library(RSQLite)

con <- dbConnect(SQLite(), "data/database/salt.db")

# Export completed surveys
surveys <- dbGetQuery(con, "
  SELECT * FROM completed_surveys
  WHERE created_at >= date('now', '-30 days')
")

# Close connection
dbDisconnect(con)
```

### Data Privacy Considerations

- Exported data may contain PII (Personally Identifiable Information)
- Apply data protection policies before export
- Consider de-identification for analysis
- Secure file transfer and storage
- Implement access controls for exported files

---

## API Documentation

### Authentication

All API endpoints require authentication via:

**Option 1: Session Cookie** (web interface)
- Automatic after web login
- Session-based authentication

**Option 2: Bearer Token** (tablets/API clients)
```
Authorization: Bearer salt_<facility-uuid>
```

### Survey Synchronization

#### Download Survey
```http
GET /api/sync/survey/download
Authorization: Bearer <facility-api-key>
```

Response:
```json
{
  "survey": {
    "id": 1,
    "name": "Survey Name",
    "questions": [...],
    "survey_config": {
      "enable_fingerprint": true,
      "fingerprint_reenrollment_days": 90
    }
  },
  "systemMessages": [...]
}
```

#### Upload Completed Survey
```http
POST /api/sync/survey/upload
Authorization: Bearer <facility-api-key>
Content-Type: application/json

{
  "survey_response_id": "uuid",
  "participant_id": "P12345",
  "survey_id": 1,
  "facility_id": 1,
  "answers": [...],
  "metadata": {...}
}
```

Response:
```json
{
  "success": true,
  "message": "Survey uploaded successfully"
}
```

### Facility Configuration

#### Get Facility Config
```http
GET /api/sync/facility/config
Authorization: Bearer <facility-api-key>
```

Response:
```json
{
  "facility_id": 1,
  "facility_name": "Main Clinic",
  "coupon_limit": 3,
  "upload_server": "http://localhost:3000",
  "settings": {...}
}
```

### Admin Endpoints

Full API documentation for admin endpoints:

- `POST /api/admin/facilities` - Create facility
- `PUT /api/admin/facilities/:id` - Update facility
- `GET /api/admin/survey-config/:surveyId` - Get survey configuration
- `POST /api/admin/survey-config/:surveyId/questions` - Create question
- `PUT /api/admin/survey-config/:surveyId/messages/:messageKey` - Update system message
- `GET /api/uploads/:surveyId` - Get uploaded survey data

See [CLAUDE.md](CLAUDE.md) for complete API reference.


## Next Steps

After completing setup:

1. **Configure First Survey**
   - [Survey Configuration](#survey-configuration)
   - Upload survey JSON or create in editor
   - Test with sample data

2. **Set Up Tablets**
   - See [Android Tablet Setup Guide](../salt_android/README.md)
   - Generate facility short codes
   - Configure tablets with server URL and API key

3. **Configure Lab Tests**
   - [Lab Test Configuration](#lab-test-configuration)
   - Create test definitions
   - Train lab staff on result entry

4. **Test Data Flow**
   - Complete test survey on tablet
   - Verify upload to server
   - Export data and review format
   - Run sample analysis with R

5. **Production Readiness**
   - Change default passwords
   - Enable HTTPS
   - Set up backups
   - Configure monitoring
   - Train staff
