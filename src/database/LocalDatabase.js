/**
 * LocalDatabase — pglite-backed replacement for Database.js
 *
 * Drop-in replacement for production PostgreSQL when DB_LOCAL=true.
 * Data persists to ./data/local.db (configurable via LOCAL_DB_PATH).
 *
 * API is identical to Database.js so all services work unchanged.
 */
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

let instance = null;

class LocalDatabase {
    constructor() {
        const dbPath = process.env.LOCAL_DB_PATH
            || path.join(process.cwd(), 'data', 'local.db');
        console.log('[LocalDB] pglite at', dbPath);
        this._client = new PGlite(dbPath);
        this._ready  = this._client.waitReady;
    }

    static getInstance() {
        if (!instance) instance = new LocalDatabase();
        return instance;
    }

    /** Reset singleton — used by migrate-local.js to get a fresh instance */
    static resetInstance() { instance = null; }

    async connect() {
        await this._ready;
        console.log('[LocalDB] Ready');
    }

    async close() {
        await this._client.close();
    }

    /**
     * Run SQL. Handles both:
     *   - multi-statement DDL (schema migrations) via exec()
     *   - normal parameterised queries via query()
     */
    async query(sql, params = []) {
        await this._ready;
        try {
            // Multi-statement SQL (no params) → use exec, return empty result
            if (params.length === 0 && this._isMultiStatement(sql)) {
                await this._client.exec(sql);
                return { rows: [], fields: [], rowCount: 0 };
            }
            const r = await this._client.query(sql, params);
            return {
                rows:     r.rows     || [],
                fields:   r.fields   || [],
                rowCount: r.affectedRows ?? r.rows?.length ?? 0,
            };
        } catch (err) {
            console.error('[LocalDB] query error:', err.message, '| sql:', sql.slice(0, 120));
            throw err;
        }
    }

    async queryOne(sql, params = []) {
        const r = await this.query(sql, params);
        return r.rows[0] || null;
    }

    async queryAll(sql, params = []) {
        const r = await this.query(sql, params);
        return r.rows;
    }

    /**
     * Expose a `.pool` shim so code that accesses `Database.getInstance().pool`
     * (e.g. Pipeline.js, runCell.js) continues to work unchanged.
     */
    get pool() {
        return {
            query:   this.query.bind(this),
            connect: async () => ({
                query:   this.query.bind(this),
                release: () => {},
            }),
            on: () => {},   // ignore pool event listeners
        };
    }

    // A statement is "multi" if it contains 2+ semicolons (beyond whitespace/trailing)
    _isMultiStatement(sql) {
        const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const semis = (stripped.match(/;/g) || []).length;
        return semis >= 2;
    }
}

module.exports = LocalDatabase;
