/**
 * GoogleDriveService — upload a binary buffer (PDF) to Drive, make it publicly
 * viewable, and return the shareable URL.
 *
 * Used by the CV PDF save-back flow:
 *   1. Render PDF via CVPdfService
 *   2. uploadPdf({ filename, buffer, folderId }) → { fileId, webViewLink }
 *   3. GoogleSheetsServiceV2.updateRow(config, rowNumber, { cv_pdf_url: webViewLink })
 *
 * Auth: same service-account JSON used by GoogleSheetsServiceV2.
 * Connection config additional fields:
 *   - drive_folder_id  (optional) — where to drop the file. If omitted, root.
 *   - share_with_anyone (bool, default true) — set 'reader' permission for anyone with link.
 */
const axios  = require('axios');
const Logger = require('../Logger');
const { _accessToken } = require('./GoogleSheetsServiceV2');

function _googleErr(prefix, err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const detail = body?.error?.message || body?.error_description || body?.error || err.message;
    return Object.assign(
        new Error(`${prefix} (HTTP ${status || '???'}): ${detail}`),
        { httpStatus: status, googleError: body?.error, rawBody: body }
    );
}

const logger = new Logger('GoogleDriveService');

/**
 * Upload a PDF buffer.
 *   filename:  display name in Drive
 *   buffer:    Node Buffer (PDF bytes)
 *   folderId:  optional parent folder
 *   makePublic: default true — set "anyone with link" permission
 *
 * Returns { fileId, webViewLink, directDownloadLink }.
 */
async function uploadPdf(config, { filename, buffer, folderId, makePublic = true }) {
    if (!buffer || !buffer.length) throw new Error('uploadPdf: buffer is empty');
    const token = await _accessToken(config);

    const metadata = { name: filename };
    if (folderId || config.drive_folder_id) metadata.parents = [folderId || config.drive_folder_id];

    const boundary = '----lpfPdfUpload' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--`),
    ]);

    let res;
    try {
        res = await axios.post(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink',
            body,
            {
                headers: {
                    Authorization:    `Bearer ${token}`,
                    'Content-Type':   `multipart/related; boundary=${boundary}`,
                    'Content-Length': body.length,
                },
                maxBodyLength: Infinity,
                timeout:       60000,
            }
        );
    } catch (err) {
        throw _googleErr(`Drive upload failed (file="${filename}")`, err);
    }

    const fileId = res.data?.id;
    if (!fileId) throw new Error('Drive upload returned no id');

    let webViewLink = res.data?.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    if (makePublic && (config.share_with_anyone ?? true)) {
        try {
            await axios.post(
                `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
                { role: 'reader', type: 'anyone' },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
            );
        } catch (err) {
            logger.warn('Drive permission set failed (file uploaded but not public)', { error: err.message });
        }
    }

    logger.debug('Drive PDF uploaded', { filename, fileId });
    return {
        fileId,
        webViewLink,
        directDownloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
    };
}

/**
 * Lightweight test — fetches `about?fields=user` so we know the service account
 * can talk to Drive. Returns { ok, user_email }.
 */
async function testDrive(config) {
    const token = await _accessToken(config);
    try {
        const r = await axios.get('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
            headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        });
        return {
            ok:         true,
            user_email: r.data?.user?.emailAddress || null,
            user_name:  r.data?.user?.displayName || null,
        };
    } catch (err) {
        throw _googleErr('Drive auth test failed', err);
    }
}

module.exports = { uploadPdf, testDrive };
