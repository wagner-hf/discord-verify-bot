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

// IDs de Roles en Discord
const ROLE_AAA = '1518678337839431971'; // Asymmetric Alpha Alerts
const ROLE_BRA = '1518679378916278432'; // Breakout Resource Alerts
const ROLE_SSA = '1534634750101160096'; // Special Situations Alerts
const ROLE_TCA = '1534634874500153415'; // Tactical Cashflow Alerts
const ROLE_TYS = '1540103931563090031'; // Total Yield Stocks
const ROLE_UGS = '1540104212178796626'; // Ultra Growth Stocks
const ROLE_PWC = '1540104362636869733'; // Private Wealth Club

// Autenticación con Google Sheets
const auth = new google.auth.GoogleAuth({
    keyFile: './offboarding-service-502720-b08da5c484e5.json',
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
        console.error(`❌ Error buscando en Teachable a ${email}:`, error.message);
        return null;
    }
}

// Función para ASIGNAR un rol en Discord (Método PUT)
async function addDiscordRole(discordUserId, roleId, roleName) {
    try {
        await axios.put(
            `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
            {},
            { headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` } }
        );
        console.log(`   ➕ Rol [${roleName}] asignado en Discord al usuario ID: ${discordUserId}`);
    } catch (error) {
        console.error(`   ⚠️ No se pudo asignar el rol [${roleName}] al usuario ${discordUserId}:`, error.response?.data || error.message);
    }
}

// Actualiza las Columnas D (Status) a la K (PWC) en Google Sheets
async function updateSheetRow(rowNumber, status, aaa, bra, ssa, tca, tys, ugs, pwc) {
    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Source of Truth!D${rowNumber}:K${rowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[status, aaa, bra, ssa, tca, tys, ugs, pwc]] }
        });
        console.log(`   📄 Fila ${rowNumber} Sheet -> Status: ${status} | AAA: ${aaa} | BRA: ${bra} | SSA: ${ssa} | TCA: ${tca} | TYS: ${tys} | UGS: ${ugs} | PWC: ${pwc}`);
    } catch (error) {
        console.error(`   ❌ Error actualizando Google Sheets en fila ${rowNumber}:`, error.message);
    }
}

// ==========================================
// FUNCIÓN PRINCIPAL (WORKER)
// ==========================================
async function runFullSync() {
    console.log('🚀 Iniciando Sincronización Total (Backfill + Discord Sync)...\n');

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Source of Truth!A:K', // Leemos hasta la K
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('⚠️ No se encontraron datos en el Sheet.');
            return;
        }

        let totalUpdated = 0;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const email = row[0];
            const discordUserId = row[1]; // Columna B

            // Evaluar solo filas que tengan correo electrónico
            if (!email) continue;

            console.log(`🔍 [${i}/${rows.length - 1}] Evaluando usuario: ${email}`);

            const teachableData = await getTeachableUser(email);
            if (!teachableData) {
                console.log(`   ⚠️ No encontrado en Teachable. Saltando...\n`);
                continue;
            }

            const courses = teachableData.courses || [];
            
            // Filtrar únicamente inscripciones activas
            const activeCourses = courses
                .filter(c => c.is_active_enrollment === true)
                .map(c => (c.course_name || '').toLowerCase());

            // Verificar membresías
            const hasAAA = activeCourses.some(name => name.includes('asymmetric alpha'));
            const hasBRA = activeCourses.some(name => name.includes('breakout resource'));
            const hasSSA = activeCourses.some(name => name.includes('special situations'));
            const hasTCA = activeCourses.some(name => name.includes('tactical cashflow'));
            const hasTYS = activeCourses.some(name => name.includes('total yield'));
            const hasUGS = activeCourses.some(name => name.includes('ultra growth'));
            const hasPWC = activeCourses.some(name => name.includes('private wealth'));

            // Asignar roles en Discord si tiene ID
            if (discordUserId) {
                if (hasAAA) await addDiscordRole(discordUserId, ROLE_AAA, 'Asymmetric Alpha Alerts');
                if (hasBRA) await addDiscordRole(discordUserId, ROLE_BRA, 'Breakout Resource Alerts');
                if (hasSSA) await addDiscordRole(discordUserId, ROLE_SSA, 'Special Situations Alerts');
                if (hasTCA) await addDiscordRole(discordUserId, ROLE_TCA, 'Tactical Cashflow Alerts');
                if (hasTYS) await addDiscordRole(discordUserId, ROLE_TYS, 'Total Yield Stocks');
                if (hasUGS) await addDiscordRole(discordUserId, ROLE_UGS, 'Ultra Growth Stocks');
                if (hasPWC) await addDiscordRole(discordUserId, ROLE_PWC, 'Private Wealth Club');
            } else {
                console.log(`   ℹ️ El usuario no tiene Discord User ID. Se actualizará solo el Sheet.`);
            }

            // Formatear valores para Google Sheets
            const finalStatus = (hasAAA || hasBRA || hasSSA || hasTCA || hasTYS || hasUGS || hasPWC) ? 'Active' : 'Inactive';
            const excelRowNumber = i + 1;
            
            await updateSheetRow(
                excelRowNumber, 
                finalStatus, 
                hasAAA ? 'Yes' : 'No', 
                hasBRA ? 'Yes' : 'No', 
                hasSSA ? 'Yes' : 'No', 
                hasTCA ? 'Yes' : 'No',
                hasTYS ? 'Yes' : 'No',
                hasUGS ? 'Yes' : 'No',
                hasPWC ? 'Yes' : 'No'
            );

            totalUpdated++;
            console.log('----------------------------------------------------');
            
            // Delay de 1 segundo para no saturar las APIs
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`\n🏁 Sincronización Total finalizada. ${totalUpdated} usuarios evaluados y actualizados.`);
    } catch (error) {
        console.error('❌ Error crítico en el proceso de sincronización:', error);
    }
}

runFullSync();