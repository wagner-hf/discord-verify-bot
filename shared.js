// Configuración y funciones compartidas por index.js (offboarding) y full-sync.js.
// Para agregar un producto nuevo: 1) una línea en PRODUCTS, 2) su encabezado en el Sheet
// (la siguiente columna libre), 3) su ruta en el Zap de onboarding. Nada más.
require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

const { SPREADSHEET_ID, TEACHABLE_API_KEY, DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
const SHEET = 'Source of Truth';
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

// "match" debe ser parte del nombre EXACTO del curso en Teachable (en minúsculas).
const PRODUCTS = [
    { key: 'AAA', name: 'Asymmetric Alpha Alerts',   match: 'asymmetric alpha',     roleId: process.env.ROLE_AAA || '1518678337839431971', col: 'E' },
    { key: 'BRA', name: 'Breakout Resource Alerts',  match: 'breakout resource',    roleId: process.env.ROLE_BRA || '1518679378916278432', col: 'F' },
    { key: 'SSA', name: 'Special Situations Alerts', match: 'special situations',   roleId: process.env.ROLE_SSA || '1534634750101160096', col: 'G' },
    { key: 'TCA', name: 'Tactical Cashflow Alerts',  match: 'tactical cashflow',    roleId: process.env.ROLE_TCA || '1534634874500153415', col: 'H' },
    { key: 'TYS', name: 'Total Yield Stocks',        match: 'total yield',          roleId: process.env.ROLE_TYS || '1540103931563090031', col: 'I' },
    { key: 'UGS', name: 'Ultra Growth Stocks',       match: 'ultra growth',         roleId: process.env.ROLE_UGS || '1540104212178796626', col: 'J' },
    { key: 'PWC', name: 'Private Wealth Club',       match: 'private wealth',       roleId: process.env.ROLE_PWC || '1540104362636869733', col: 'K' },
    { key: 'HFP', name: 'Heresy Financial Pro',      match: 'heresy financial pro', roleId: process.env.ROLE_HFP || '1561773168253865984', col: 'L' },
];
const LAST_COL = PRODUCTS[PRODUCTS.length - 1].col;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Las columnas de productos deben ser consecutivas desde la E.
function validateProducts() {
    PRODUCTS.forEach((p, k) => {
        const expected = String.fromCharCode('E'.charCodeAt(0) + k);
        if (p.col !== expected) throw new Error(`Columna de ${p.name} debe ser ${expected}, no ${p.col}`);
        if (!p.roleId) console.warn(`⚠️ ${p.name} no tiene roleId: su rol no se toca (solo su columna).`);
    });
}

// ---------- Google Sheets ----------
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function readRows() {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET}!A:${LAST_COL}` });
    return res.data.values || [];
}

async function updateRow(rowNumber, values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET}!D${rowNumber}:${LAST_COL}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
    });
}

// ---------- Reintentos ----------
// Reintenta ante límites de velocidad (429), errores 5xx y cortes de red (ECONNRESET, timeouts).
const NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'];
async function withRetry(fn, label, attempts = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const status = e.response?.status;
            const retriable = status === 429 || (status >= 500 && status < 600) || NETWORK_CODES.includes(e.code);
            if (!retriable || attempt >= attempts) throw e;
            const retryAfter = Number(e.response?.data?.retry_after || e.response?.headers?.['retry-after'] || 0);
            const wait = retryAfter ? Math.ceil(retryAfter * 1000) + 250 : 1000 * 2 ** (attempt - 1);
            console.warn(`   ⏳ ${label}: ${status || e.code}, reintento ${attempt}/${attempts - 1} en ${wait} ms`);
            await sleep(wait);
        }
    }
}

// ---------- Teachable ----------
// Devuelve { status: 'ok', courses } | { status: 'not_found' } | { status: 'error', message }
async function getTeachableUser(email) {
    const headers = { Accept: 'application/json', apikey: TEACHABLE_API_KEY };
    try {
        const search = await withRetry(
            () => axios.get('https://developers.teachable.com/v1/users', { headers, params: { email }, timeout: 20000 }),
            'Teachable (buscar)'
        );
        const users = search.data.users || [];
        if (users.length === 0) return { status: 'not_found' };
        const details = await withRetry(
            () => axios.get(`https://developers.teachable.com/v1/users/${users[0].id}`, { headers, timeout: 20000 }),
            'Teachable (detalle)'
        );
        if (!Array.isArray(details.data.courses)) return { status: 'error', message: 'respuesta sin lista de cursos' };
        return { status: 'ok', courses: details.data.courses };
    } catch (e) {
        return { status: 'error', message: e.response?.status || e.code || e.message };
    }
}

// Un true/false por producto, en el orden de PRODUCTS.
function activeFlags(courses) {
    const active = courses
        .filter((c) => c.is_active_enrollment === true)
        .map((c) => String(c.course_name || '').toLowerCase());
    return PRODUCTS.map((p) => active.some((n) => n.includes(p.match)));
}

// [Status, Yes/No por producto]: Inactive solo si no tiene NINGUNA membresía activa.
function rowValues(has) {
    return [has.some(Boolean) ? 'Active' : 'Inactive'].concat(has.map((h) => (h ? 'Yes' : 'No')));
}

function currentValues(row) {
    return [row[3] || ''].concat(PRODUCTS.map((p, k) => row[4 + k] || ''));
}

function keysOf(has) {
    const list = PRODUCTS.filter((p, k) => has[k]).map((p) => p.key);
    return list.length ? list.join(', ') : 'ninguno';
}

// ---------- Discord ----------
const discord = axios.create({
    baseURL: 'https://discord.com/api/v10',
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    timeout: 20000,
});

// Roles actuales del miembro, o null si ya no está en el servidor.
async function getMemberRoles(discordUserId) {
    try {
        const res = await withRetry(() => discord.get(`/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`), 'Discord (leer miembro)');
        return res.data.roles || [];
    } catch (e) {
        if (e.response?.status === 404) return null;
        throw e;
    }
}

async function addRole(discordUserId, roleId) {
    await withRetry(() => discord.put(`/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`, {}), 'Discord (dar rol)');
}

async function removeRole(discordUserId, roleId) {
    await withRetry(() => discord.delete(`/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`), 'Discord (quitar rol)');
}

module.exports = {
    DRY_RUN, PRODUCTS, sleep, validateProducts,
    readRows, updateRow,
    getTeachableUser, activeFlags, rowValues, currentValues, keysOf,
    getMemberRoles, addRole, removeRole,
};
