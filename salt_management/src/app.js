const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const session = require('express-session');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Security middleware
// In development, disable headers that require HTTPS to allow access via IP address
// In production, all security headers are enabled
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            mediaSrc: ["'self'", "blob:", "data:"],
            connectSrc: ["'self'", "blob:", "data:"],
            workerSrc: ["'self'", "blob:"],
            // Only upgrade insecure requests in production
            ...(isProduction ? { upgradeInsecureRequests: [] } : { upgradeInsecureRequests: null }),
        },
    },
    crossOriginOpenerPolicy: isProduction,
    crossOriginEmbedderPolicy: isProduction,
    hsts: isProduction,
}));

// CORS — locked to this server's own origin.
//
// Nothing legitimately needs cross-origin browser access: the admin web UI
// is same-origin, and the Android tablet is a native HTTP client that
// ignores CORS entirely. The allowed set is computed per request from the
// Host header, so every deployment / subdomain locks to itself with zero
// configuration. CORS_ORIGIN (comma-separated) can add extra origins if a
// future browser-based consumer ever needs one.
app.use(cors((req, callback) => {
    const host = req.headers.host;
    const allowed = [];
    if (host) {
        allowed.push(`https://${host}`, `http://${host}`);
    }
    const extra = (process.env.CORS_ORIGIN || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    allowed.push(...extra);
    callback(null, { origin: allowed, credentials: true });
}));

// Compression
app.use(compression());

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/js/lamejs', express.static(path.join(__dirname, '..', 'node_modules', 'lamejs')));
// Markdown preview libraries for the survey editor (vendored from node_modules)
app.use('/js/marked', express.static(path.join(__dirname, '..', 'node_modules', 'marked')));
app.use('/js/dompurify', express.static(path.join(__dirname, '..', 'node_modules', 'dompurify', 'dist')));
// Serve files from data/files directory (for APK downloads etc.)
app.use('/files', express.static(path.join(__dirname, '..', 'data', 'files')));

// Session configuration for web UI
app.use(session({
    secret: process.env.SESSION_SECRET || 'salt-management-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax', // not sent on cross-site POSTs or subresource requests
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'web', 'views'));

// Import routes
const healthRoutes = require('./api/routes/health');
const authRoutes = require('./api/routes/auth');
const surveyRoutes = require('./api/routes/surveys');
const facilityRoutes = require('./api/routes/facilities');
const surveyConfigRoutes = require('./api/routes/surveyConfigSimple');
const surveySyncRoutes = require('./api/routes/surveySync');
const surveyUploadRoutes = require('./api/routes/surveyUpload');
const facilityConfigRoutes = require('./api/routes/facilityConfig');
const surveyMessagesRoutes = require('./api/routes/surveyMessages');
const testConfigRoutes = require('./api/routes/testConfig');
const usersRoutes = require('./api/routes/users');
const labTestsRoutes = require('./api/routes/labTests');
const labResultsRoutes = require('./api/routes/labResults');
const dataExportRoutes = require('./api/routes/dataExport');
const consentExportRoutes = require('./api/routes/consentExport');
const paymentExportRoutes = require('./api/routes/paymentExport');
const reportsRoutes = require('./api/routes/reports');
const recruitmentPaymentUploadRoutes = require('./api/routes/recruitmentPaymentUpload');
const facilityRestoreRoutes = require('./api/routes/facilityRestore');
const logUploadRoutes = require('./api/routes/logUpload');
const webDashboardRoutes = require('./web/routes/dashboard');
const webSurveyEditorRoutes = require('./web/routes/surveyEditor');
const webUserManagementRoutes = require('./web/routes/userManagement');
const webLabEntryRoutes = require('./web/routes/labEntry');
const webLabTestManagementRoutes = require('./web/routes/labTestManagement');
const webDataExportRoutes = require('./web/routes/dataExport');
const webReportsRoutes = require('./web/routes/reports');
const webEditDataRoutes = require('./web/routes/editData');
const subjectManagementRoutes = require('./api/routes/subjectManagement');
const surveyExportRoutes = require('./api/routes/surveyExport');

// Initialize report scheduler
const reportScheduler = require('./services/reportScheduler');

// API Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/surveys', surveyRoutes);
app.use('/api/admin/facilities', facilityRoutes);
app.use('/api/admin/survey-config', surveyConfigRoutes);
app.use('/api/admin/survey-config', surveyMessagesRoutes);
app.use('/api/admin/users', usersRoutes);
app.use('/api/admin', labTestsRoutes);
app.use('/api/admin', labResultsRoutes);
app.use('/api/admin', dataExportRoutes);
app.use('/api', subjectManagementRoutes);
app.use('/api', surveyExportRoutes);
app.use('/api/admin', consentExportRoutes);
app.use('/api/admin', paymentExportRoutes);
app.use('/api/admin', testConfigRoutes);
app.use('/api', reportsRoutes);
app.use('/api/sync', surveySyncRoutes);
app.use('/api/sync', surveyUploadRoutes);
app.use('/api/sync', facilityConfigRoutes);
app.use('/api/sync', recruitmentPaymentUploadRoutes);
app.use('/api/sync', facilityRestoreRoutes);
app.use('/api/sync', logUploadRoutes);

// Web Routes
app.use('/', webDashboardRoutes);
app.use('/', webSurveyEditorRoutes);
app.use('/', webUserManagementRoutes);
app.use('/', webLabEntryRoutes);
app.use('/', webLabTestManagementRoutes);
app.use('/', webDataExportRoutes);
app.use('/', webReportsRoutes);
app.use('/', webEditDataRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Fallback handlers (404 + error) and server start are registered AFTER the
// optional MCP server mounts, so MCP routes resolve ahead of the catch-all 404.
function registerFallbackHandlers() {
    // 404 handler
    app.use((req, res, next) => {
        if (req.path.startsWith('/api')) {
            res.status(404).json({ error: 'Endpoint not found' });
        } else {
            res.status(404).render('pages/404', { title: 'Page Not Found' });
        }
    });

    // Error handler
    app.use((err, req, res, next) => {
        console.error('Error:', err);

        if (req.path.startsWith('/api')) {
            res.status(err.status || 500).json({
                error: process.env.NODE_ENV === 'production'
                    ? 'Internal server error'
                    : err.message
            });
        } else {
            res.status(err.status || 500).render('pages/error', {
                title: 'Error',
                message: process.env.NODE_ENV === 'production'
                    ? 'Something went wrong'
                    : err.message
            });
        }
    });
}

function startServer() {
    app.listen(PORT, () => {
        console.log(`SALT Management Server running on port ${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`API endpoint: http://localhost:${PORT}/api`);
        console.log(`Web UI: http://localhost:${PORT}`);
    });
}

// Mount the optional MCP report-builder server (opt-in via MCP_ENABLED), then
// register the catch-all handlers and start listening. MCP failures never block
// the rest of the server.
require('./mcp').init(app)
    .catch(err => console.error('[mcp] init failed, continuing without MCP:', err))
    .finally(() => { registerFallbackHandlers(); startServer(); });