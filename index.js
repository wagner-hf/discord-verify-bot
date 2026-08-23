require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

// ==========================================
// CONFIGURACIÓN Y CONSTANTES
// ==========================================
const {
    SPREADSHEET_ID,
    TEACHABLE_API_KEY,
    DISCORD_TOKEN,
    DISCORD_GUILD_ID
} = process.env;

const ROLE_AAA = '1518678337839431971'; // Asymmetric Alpha Alerts
const ROLE_BRA = '1518679378916278432'; // Breakout Resource Alerts
const ROLE_SSA = '1534634750101160096'; // Special Situations Alerts
const ROLE_TCA = '1534634874500153415'; // Tactical Cashflow Alerts
const ROLE_TYS = '1540103931563090031'; // Total Yield Stocks
const ROLE_UGS = '1540104212178796626'; // Ultra Growth Stocks
const ROLE_PWC = '1540104362636869733'; // Private Wealth Club

// Inicializar cliente de Google Sheets para Heroku
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// ==========================================
// FUNCIONES AUXILIARES (APIs)
// ==========================================

async function getTeachableUser(email) {
    try {
        const searchResponse = await axios.get(`https://developers.teachable.com/v1/users`, {
            headers: { 'Accept': 'application/json', 'apikey': TEACHABLE_API_KEY },
            params: { email: email }
        });

        const users = searchResponse.data.users || [];
        if (users.length === 0) return null;

        const studentId = users[0].id;
        const userDetails = await axios.get(`https://developers.teachable.com/v1/users/${studentId}`, {
            headers: { 'Accept': 'application/json', 'apikey': TEACHABLE_API_KEY }
        });

        return userDetails.data;
    } catch (error) {
        console.error(`❌ Error buscando en Teachable el email ${email}:`, error.message);
        return null;
    }
}

async function removeDiscordRole(discordUserId, roleId, roleName) {
    try {
        await axios.delete(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`, {
            headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` }
        });
        console.log(`✅ Rol [${roleName}] removido en Discord para el usuario ${discordUserId}`);
    } catch (error) {
        console.error(`❌ Error removiendo rol [${roleName}] al usuario ${discordUserId}:`, error.response?.data || error.message);
    }
}

// ACTUALIZADO: Actualiza Status (D) hasta PWC (K) al mismo tiempo
async function updateSheetData(rowNumber, status, hasAAA, hasBRA, hasSSA, hasTCA, hasTYS, hasUGS, hasPWC) {
    try {
        const aaaText = hasAAA ? 'Yes' : 'No';
        const braText = hasBRA ? 'Yes' : 'No';
        const ssaText = hasSSA ? 'Yes' : 'No';
        const tcaText = hasTCA ? 'Yes' : 'No';
        const tysText = hasTYS ? 'Yes' : 'No';
        const ugsText = hasUGS ? 'Yes' : 'No';
        const pwcText = hasPWC ? 'Yes' : 'No';

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Source of Truth!D${rowNumber}:K${rowNumber}`, // Abarca de la D a la K (8 columnas)
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[status, aaaText, braText, ssaText, tcaText, tysText, ugsText, pwcText]] }
        });
        console.log(`✅ Fila ${rowNumber} actualizada -> Status: ${status}, AAA: ${aaaText}, BRA: ${braText}, SSA: ${ssaText}, TCA: ${tcaText}, TYS: ${tysText}, UGS: ${ugsText}, PWC: ${pwcText}`);
    } catch (error) {
        console.error(`❌ Error actualizando Sheets en fila ${rowNumber}:`, error.message);
    }
}

// ==========================================
// FUNCIÓN PRINCIPAL (WORKER)
// ==========================================
async function runOffboardingWorker() {
    console.log('🚀 Iniciando script de Offboarding...\n');

    const removedRolesSummary = [];

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Source of Truth!A:K', // Leemos hasta la K para incluir todas las estrategias
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('⚠️ No se encontraron datos en el Sheet.');
            return;
        }

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const email = row[0];
            const discordUserId = row[1];
            const status = row[3];

            if (status === 'Active' && email && discordUserId) {
                console.log(`🔍 Evaluando usuario: ${email}`);

                const teachableData = await getTeachableUser(email);

                if (!teachableData) {
                    console.log(`⚠️ Usuario ${email} no encontrado en Teachable. Saltando...\n`);
                    continue;
                }

                const courses = teachableData.courses || [];
                const activeCourses = courses
                    .filter(course => course.is_active_enrollment === true)
                    .map(course => course.course_name.toLowerCase());

                const hasAAA = activeCourses.some(name => name.includes('asymmetric alpha'));
                const hasBRA = activeCourses.some(name => name.includes('breakout resource'));
                const hasSSA = activeCourses.some(name => name.includes('special situations'));
                const hasTCA = activeCourses.some(name => name.includes('tactical cashflow'));
                const hasTYS = activeCourses.some(name => name.includes('total yield'));
                const hasUGS = activeCourses.some(name => name.includes('ultra growth'));
                const hasPWC = activeCourses.some(name => name.includes('private wealth'));

                let statusChanged = false;

                // Path A: Asymmetric Alpha Alerts
                if (!hasAAA) {
                    await removeDiscordRole(discordUserId, ROLE_AAA, 'Asymmetric Alpha Alerts');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Asymmetric Alpha Alerts' });
                    statusChanged = true;
                }

                // Path B: Breakout Resource Alerts
                if (!hasBRA) {
                    await removeDiscordRole(discordUserId, ROLE_BRA, 'Breakout Resource Alerts');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Breakout Resource Alerts' });
                    statusChanged = true;
                }

                // Path C: Special Situations Alerts
                if (!hasSSA) {
                    await removeDiscordRole(discordUserId, ROLE_SSA, 'Special Situations Alerts');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Special Situations Alerts' });
                    statusChanged = true;
                }

                // Path D: Tactical Cashflow Alerts
                if (!hasTCA) {
                    await removeDiscordRole(discordUserId, ROLE_TCA, 'Tactical Cashflow Alerts');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Tactical Cashflow Alerts' });
                    statusChanged = true;
                }

                // Path E: Total Yield Stocks
                if (!hasTYS) {
                    await removeDiscordRole(discordUserId, ROLE_TYS, 'Total Yield Stocks');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Total Yield Stocks' });
                    statusChanged = true;
                }

                // Path F: Ultra Growth Stocks
                if (!hasUGS) {
                    await removeDiscordRole(discordUserId, ROLE_UGS, 'Ultra Growth Stocks');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Ultra Growth Stocks' });
                    statusChanged = true;
                }

                // Path G: Private Wealth Club
                if (!hasPWC) {
                    await removeDiscordRole(discordUserId, ROLE_PWC, 'Private Wealth Club');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Private Wealth Club' });
                    statusChanged = true;
                }

                // Actualizar las columnas si hubo un cambio
                if (statusChanged) {
                    // Solo es 'Inactive' si NO tiene ninguna de las 7 membresías activas
                    const finalStatus = (!hasAAA && !hasBRA && !hasSSA && !hasTCA && !hasTYS && !hasUGS && !hasPWC) ? 'Inactive' : 'Active';
                    const excelRowNumber = i + 1;
                    await updateSheetData(excelRowNumber, finalStatus, hasAAA, hasBRA, hasSSA, hasTCA, hasTYS, hasUGS, hasPWC);
                }

                console.log('---');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log('\n🏁 Script de Offboarding finalizado.');
        if (removedRolesSummary.length > 0) {
            console.log('\n📊 RESUMEN DE ROLES REMOVIDOS EN ESTA SESIÓN:');
            console.table(removedRolesSummary);
        } else {
            console.log('\n📊 RESUMEN: Todos los usuarios evaluados mantienen sus suscripciones activas. No se removieron roles.');
        }

    } catch (error) {
        console.error('❌ Error crítico en el script:', error);
    }
}

runOffboardingWorker();