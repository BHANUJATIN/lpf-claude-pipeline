const { Pool } = require('pg');

let instance = null;

/**
 * Database singleton.
 * When DB_LOCAL=true (set in .env.test) returns a LocalDatabase (pglite) instance
 * instead of connecting to a remote PostgreSQL server.
 */
class Database {
    constructor() {
        const cfg = {
            host:                    process.env.POSTGRES_HOST,
            port:                    parseInt(process.env.POSTGRES_PORT || '5432'),
            database:                process.env.POSTGRES_DB || 'claude_lpf',
            user:                    process.env.POSTGRES_USER,
            password:                process.env.POSTGRES_PASSWORD,
            ssl:                     process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
            max:                     10,
            idleTimeoutMillis:       30000,
            connectionTimeoutMillis: 20000,
        };
        console.log('[DB] Pool config:', { host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, ssl: !!cfg.ssl });
        this.pool = new Pool(cfg);
        this._available = true;
        this.pool.on('connect', () => console.log('[DB] New client connected to pool'));
        this.pool.on('error', (err) => {
            this._available = false;
            console.error('[DB] Pool error:', err.message, '| code:', err.code);
            setTimeout(() => { this._available = true; }, 10000);
        });
    }

    static getInstance() {
        if (!instance) {
            if (process.env.DB_LOCAL === 'true') {
                const LocalDatabase = require('./LocalDatabase');
                return LocalDatabase.getInstance();
            }
            instance = new Database();
        }
        return instance;
    }

    async connect() {
        console.log('[DB] connect() — acquiring test client...');
        const client = await this.pool.connect();
        console.log('[DB] connect() — OK, releasing');
        client.release();
    }

    _checkAvailable() {
        if (this._available === false) throw new Error('Database temporarily unavailable');
    }

    async query(sql, params = []) {
        this._checkAvailable();
        try {
            const r = await this.pool.query(sql, params);
            this._available = true;
            return r;
        } catch (err) {
            console.error('[DB] query error:', err.message, '| code:', err.code, '| sql:', sql.slice(0, 80));
            if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
                this._available = false;
                console.error('[DB] marking pool unavailable for 15s');
                setTimeout(() => { this._available = true; }, 15000);
            }
            throw err;
        }
    }

    async queryOne(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows[0] || null;
    }

    async queryAll(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows;
    }

    get pool_ref() {
        return this.pool;
    }
}

module.exports = Database;
