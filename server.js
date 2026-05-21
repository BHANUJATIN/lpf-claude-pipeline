require('dotenv').config(); // v2
const path       = require('path');
const express    = require('express');
const Database   = require('./src/database/Database');
const Logger     = require('./src/Logger');
const webhookRoutes = require('./src/routes/webhook');
const systemRoutes  = require('./src/routes/system');

const logger = new Logger('Server');
const app    = express();

// Trust the X-Forwarded-* headers so req.protocol/req.get('host') reflect the
// public URL when the app is deployed behind a reverse proxy (Render, Heroku,
// Railway, Fly, Cloudflare, NGINX, etc.). Required for OAuth redirect URIs to
// resolve correctly on deployment — without this, req.protocol always reads
// 'http' even when the public URL is https.
app.set('trust proxy', true);

// Bind to EXACTLY the configured port. Auto-incrementing to a different port
// caused operator confusion: dashboards / OAuth redirects pinned to localhost:3000
// would silently break, but a stale instance at :3000 would still serve.
// If the port is taken, fail loud — the operator must stop the other process.
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
});

app.use('/webhook', webhookRoutes);
app.use('/',        systemRoutes);

function listenStrict(port) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port)
            .once('listening', () => resolve({ server, port }))
            .once('error', err => {
                if (err.code === 'EADDRINUSE') {
                    // Surface a clear, actionable message — most likely a stale instance.
                    const platformHint = process.platform === 'win32'
                        ? `Find it via:  netstat -ano | findstr ":${port}"  → then  taskkill /PID <pid> /F`
                        : `Find it via:  lsof -i :${port}  → then  kill <pid>`;
                    reject(new Error(
                        `Port ${port} is already in use. Another process is bound to it.\n` +
                        `${platformHint}\n` +
                        `Or change PORT in .env if you want this instance to bind somewhere else.`
                    ));
                } else {
                    reject(err);
                }
            });
    });
}

async function start() {
    // Try DB connection but don't block startup if unreachable
    console.log('[startup] attempting DB connection...');
    console.log(`[startup]   host=${process.env.POSTGRES_HOST} port=${process.env.POSTGRES_PORT} db=${process.env.POSTGRES_DB} user=${process.env.POSTGRES_USER} ssl=${process.env.POSTGRES_SSL}`);
    try {
        await Database.getInstance().connect();
        console.log('[startup] DB connection OK');
        logger.info('Database connected');

        // Pull api_key connections into process.env so existing services see them
        try {
            const Connections = require('./src/services/ConnectionService');
            const n = await Connections.hydrateApiKeysToEnv();
            if (n > 0) logger.info(`Hydrated ${n} API key(s) from lpf_connections into process.env`);
        } catch (err) {
            logger.warn('Could not hydrate API keys from connections', { error: err.message });
        }

        // 30-day retention scheduler — deletes old contacts; companies > 30d are
        // re-enriched next time their job comes in. See RetentionService.js.
        try {
            require('./src/services/RetentionService').startScheduledCleanup({ hours: 6 });
        } catch (err) {
            logger.warn('Could not start retention scheduler', { error: err.message });
        }

        // Boot-resume: jobs that were mid-pipeline when the previous process died
        // (most commonly because `node --watch` restarted on a file edit) get
        // re-queued automatically. See BootResume.js. Fire-and-forget — keeps
        // the boot path snappy + jobs resume in the background.
        //
        // Delayed by 2s so the HTTP listener is bound first (otherwise the
        // resumed jobs would emit SSE events before any client could connect).
        setTimeout(() => {
            try {
                require('./src/pipeline/BootResume').resumeInFlightJobs()
                    .then(r => {
                        if (r.resumed > 0) {
                            logger.info(`BootResume: re-queued ${r.resumed} in-flight job(s)`, { ids: r.ids });
                        }
                    })
                    .catch(err => logger.warn('BootResume failed', { error: err.message }));
            } catch (err) {
                logger.warn('Could not start boot-resume', { error: err.message });
            }
        }, 2000);
    } catch (err) {
        console.error('[startup] DB connection FAILED:', err.message, '| code:', err.code);
        logger.warn('Database unreachable at startup — server will start anyway', { error: err.message });
    }

    try {
        await listenStrict(PORT);

        logger.info('claude-jpe server running', { port: PORT });
        console.log('');
        console.log('  claude-jpe  v0.2.0');
        console.log('  ─────────────────────────────────────────────');
        console.log(`  Webhook (from JPE)   POST http://localhost:${PORT}/webhook/lpf`);
        console.log(`  Generic webhook      POST http://localhost:${PORT}/webhook  (or /webhook/<slug>)`);
        console.log(`  Dashboard            http://localhost:${PORT}`);
        console.log('');
    } catch (err) {
        console.error('');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('  Server failed to start');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error(err.message);
        console.error('');
        logger.error('Failed to bind port', { error: err.message, port: PORT });
        process.exit(1);
    }
}

// Prevent DB/network errors from crashing the whole process
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (server kept running)', { error: String(reason) });
});
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception (server kept running)', { error: err.message });
});

start();
