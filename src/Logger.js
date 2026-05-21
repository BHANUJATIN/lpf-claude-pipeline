const winston = require('winston');

let _dbService = null;
function getDb() {
    if (!_dbService) {
        try {
            const DatabaseService = require('./database/DatabaseService');
            _dbService = new DatabaseService();
        } catch (_) {}
    }
    return _dbService;
}

class PgTransport extends winston.Transport {
    constructor(opts) { super(opts); }
    log(info, callback) {
        setImmediate(() => {
            try {
                const db = getDb();
                if (db) {
                    const { level, message, module, timestamp, ...meta } = info;
                    const cleanMeta = Object.keys(meta).length ? meta : null;
                    db.insertLog(level, module || 'App', message, cleanMeta).catch(() => {});
                }
            } catch (_) {}
            callback();
        });
    }
}

class Logger {
    constructor(module) {
        this.module = module;
        const isDev = process.env.NODE_ENV !== 'production';
        this._l = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            defaultMeta: { module },
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.errors({ stack: true })
            ),
            transports: [
                new winston.transports.Console({
                    format: isDev
                        ? winston.format.combine(
                              winston.format.colorize(),
                              winston.format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
                                  const m = Object.keys(meta).length ? '  ' + JSON.stringify(meta) : '';
                                  return `${timestamp} [${(mod || '?').padEnd(18)}] ${level}: ${message}${m}`;
                              })
                          )
                        : winston.format.json(),
                }),
                new PgTransport({ level: process.env.LOG_LEVEL || 'info' }),
            ],
        });
    }
    info(msg, meta = {})    { this._l.info(msg, meta); }
    warn(msg, meta = {})    { this._l.warn(msg, meta); }
    error(msg, meta = {})   { this._l.error(msg, meta); }
    debug(msg, meta = {})   { this._l.debug(msg, meta); }
}

module.exports = Logger;
